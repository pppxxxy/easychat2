import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// characterLibrary 依赖 storage/characters.js（快赢1 前经 storage.js 门面，
// 会拉入 async-storage / secrets），沿用仓库既有做法：babel 转译到真实源码路径后注入内存模块加载。
const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/context/characterLibrary.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

// ../storage 是原生 ESM（Node 直接解析会绕开 Module._load 拦截，并在
// expo-file-system 的扩展名解析上失败）。characterLibrary 只用到
// DEFAULT_CHARACTER 与 sortCharacters，这里按真实语义提供最小替身。
// 注意这些字段必须与 storage/characters/shared.js:9-34 的 DEFAULT_CHARACTER 对齐
// （尤其是内置助手的教学 firstMes / systemPrompt）——withAddedCharacter 的
// 「继承 vs 清空」测试就是拿它们当被测输入，替身缺字段会让断言永远通过。
const DEFAULT_CHARACTER = {
  id: 'default',
  builtin: true,
  name: 'EasyChat2 助手',
  systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。',
  firstMes: '你好，我是 EasyChat2 助手。开始很简单：1. 打开底部「设置」…',
  alternateGreetings: ['助手备用问候'],
  description: '',
  personality: '',
  scenario: '',
  avatarUri: '',
  bgUri: '',
  tags: [],
  worldInfo: [],
  regexScripts: [],
  presets: [],
  voiceDisplay: 'text',
  lastUsedAt: 0,
};
function sortCharacters(list) {
  return [...list].sort((a, b) => {
    const pinnedDiff = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
    if (pinnedDiff !== 0) return pinnedDiff;
    const diff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}
const storageMock = { __esModule: true, DEFAULT_CHARACTER, sortCharacters };

// 诊断与 i18n 的记录型替身：resolveStartupFailure 的「留痕 + 可见文案」要可断言。
const recordedDiagnostics = [];
const diagnosticsMock = {
  __esModule: true,
  recordDiagnostic: (kind, error, context) => {
    recordedDiagnostics.push({ kind, message: String((error && error.message) || error), context });
  },
};
const i18nMock = {
  __esModule: true,
  // 直接回显 key：断言文案时钉的是「用了哪条词条」，不是词条内容（内容由 i18n 测试保证）。
  tActive: key => `[${key}]`,
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  // 快赢1 后 characterLibrary.js 直达 storage/characters.js（原经 storage.js 门面）。
  if (
    request === '../storage.js'
    || request.endsWith('/storage')
    || request.endsWith('/storage/characters.js')
  ) return storageMock;
  if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
    return diagnosticsMock;
  }
  if (request.endsWith('/i18n/index.js') || request === './i18n/index.js') return i18nMock;
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const filename = path.resolve('src/context/characterLibrary.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;

const {
  resolveActiveId,
  uniqueId,
  withUpdatedCharacter,
  withSwitchedCharacter,
  withAddedCharacter,
  withDeletedCharacter,
  withPinnedCharacter,
  withDeletedCharacters,
  runWithRollback,
  describeDefaultArtwork,
  resolveStartupFailure,
} = runtimeModule.exports;

const DEFAULT = { id: 'default', builtin: true, name: '助手', lastUsedAt: 0 };
const make = (id, extra = {}) => ({ ...DEFAULT, id, builtin: false, ...extra });

test('resolveActiveId：存在则保留，缺失则回落到内置卡', () => {
  const list = [make('a'), make('b')];
  assert.equal(resolveActiveId(list, 'b'), 'b');
  assert.equal(resolveActiveId(list, 'missing'), 'default');
  const withDefault = [make('a'), { ...DEFAULT }];
  assert.equal(resolveActiveId(withDefault, ''), 'default');
});

test('uniqueId：占用时追加递增后缀，空白基准生成随机卡号', () => {
  const list = [make('card'), make('card-2')];
  assert.equal(uniqueId('card', list), 'card-3');
  assert.equal(uniqueId('free', list), 'free');
  const generated = uniqueId('', list);
  assert.ok(generated.startsWith('card-'));
  assert.equal(list.some(c => c.id === generated), false);
});

test('withUpdatedCharacter：合并补丁且保留 id，支持函数补丁', () => {
  const list = [make('a', { name: '旧' })];
  const direct = withUpdatedCharacter(list, 'a', { name: '新' });
  assert.equal(direct.character.name, '新');
  assert.equal(direct.character.id, 'a');
  const viaFn = withUpdatedCharacter(list, 'a', prev => ({ name: `${prev.name}改` }));
  assert.equal(viaFn.character.name, '旧改');
  // 补丁试图改 id 也应被忽略
  const forced = withUpdatedCharacter(list, 'a', { id: 'hack' });
  assert.equal(forced.character.id, 'a');
});

test('withSwitchedCharacter：命中更新时间戳，未命中返回 found=false', () => {
  const list = [make('a'), make('b')];
  const hit = withSwitchedCharacter(list, 'a', 12345);
  assert.equal(hit.found, true);
  assert.equal(hit.character.lastUsedAt, 12345);
  const miss = withSwitchedCharacter(list, 'zzz', 1);
  assert.equal(miss.found, false);
  assert.equal(miss.character, null);
});

test('withAddedCharacter：写入新卡并清掉继承的 builtin 标记', () => {
  const list = [make('a')];
  const { list: next, character } = withAddedCharacter(list, { id: 'a', name: '重名', builtin: true }, 9);
  assert.equal(character.id, 'a-2');
  assert.equal(character.builtin, false);
  assert.equal(character.lastUsedAt, 9);
  assert.equal(next.some(c => c.id === 'a-2'), true);
});

// 角色页「新建」只传 { name }（CharacterLibraryScreen.js:408）。修复前
// `{ ...DEFAULT_CHARACTER, ...character }` 会把内置助手的教学开场白与人设提示静默继承
// 给新角色——用户建了张白纸，开场白却是「你好，我是 EasyChat2 助手…」。
test('withAddedCharacter：只传 name 的新卡不继承内置助手的开场白/系统提示/备用问候', () => {
  const { character } = withAddedCharacter([make('a')], { name: '新角色' }, 1);
  assert.equal(character.firstMes, '', 'firstMes 必须是空串（不是助手教学文案）');
  assert.equal(character.systemPrompt, '', 'systemPrompt 必须是空串（不是助手人设）');
  assert.deepEqual(character.alternateGreetings, [], '备用开场白与 firstMes 同族，一并清空');
  // 缺省即空是 cardHelpers.js:112/:145 的既有口径（|| ''），不是 undefined
  assert.equal(typeof character.firstMes, 'string');
  assert.equal(typeof character.systemPrompt, 'string');
  // 该继承的仍然继承：name 用调用方的，其余默认字段在位
  assert.equal(character.name, '新角色');
  assert.equal(character.builtin, false);
  assert.equal(character.voiceDisplay, 'text');
  assert.equal(character.id.startsWith('card-'), true);
});

test('withAddedCharacter：调用方显式给的值一律保留，容器不与内置卡共享引用', () => {
  const { character } = withAddedCharacter([make('a')], {
    id: 'mine',
    name: '带卡',
    firstMes: '我自己的开场白',
    systemPrompt: '我自己的人设',
    alternateGreetings: ['备选一'],
    avatarUri: 'file:///my-avatar.png',
    tags: ['标签'],
  }, 2);
  assert.equal(character.firstMes, '我自己的开场白');
  assert.equal(character.systemPrompt, '我自己的人设');
  assert.deepEqual(character.alternateGreetings, ['备选一']);
  assert.equal(character.avatarUri, 'file:///my-avatar.png', '调用方显式给的头像必须保留');
  assert.deepEqual(character.tags, ['标签']);
  // 内置卡是模块级单例：新卡绝不能与它共享可变容器
  assert.notEqual(character.tags, DEFAULT_CHARACTER.tags);
  assert.notEqual(character.alternateGreetings, DEFAULT_CHARACTER.alternateGreetings);
});

// 启动加载失败的处置（F1 的 AppContext 侧）：必须合写闸 + 留痕 + 给可见文案。
test('resolveStartupFailure：先合写闸、再留痕，并返回可见文案（用现成词条）', () => {
  recordedDiagnostics.length = 0;
  const gate = [];
  const boom = new Error('getAllKeys 读取失败');
  const failure = resolveStartupFailure(boom, value => gate.push(value));
  assert.deepEqual(gate, [true], '写闸必须被合上，且在任何写操作之前');
  assert.equal(recordedDiagnostics.length, 1, '必须留痕（此前启动加载失败在诊断里查无此事）');
  assert.equal(recordedDiagnostics[0].kind, 'startup');
  // 诊断 message 必须自足：maskSecrets 可能把 error.message 清空（去重会因此丢掉这条）
  assert.ok(recordedDiagnostics[0].message.includes('启动加载失败'), '诊断文本要自足');
  assert.ok(recordedDiagnostics[0].message.includes('写闸'));
  assert.ok(recordedDiagnostics[0].context.includes('getAllKeys 读取失败'),
    '真实错误信息进 context 便于定位');
  assert.equal(failure.title, '[error.storage.characterIndexReadFailed]',
    '复用早已写好、此前零消费的中英双语词条');
  assert.equal(failure.body, 'getAllKeys 读取失败', 'body 带真实错误信息便于定位');
});

test('resolveStartupFailure：非 Error 输入不炸，body 退化为空串由调用方兜底', () => {
  recordedDiagnostics.length = 0;
  const failure = resolveStartupFailure(undefined, () => {});
  assert.equal(failure.body, '');
  assert.equal(failure.title, '[error.storage.characterIndexReadFailed]');
  assert.equal(recordedDiagnostics.length, 1);
});

test('withDeletedCharacter：删除后若删的是当前卡则回落，removed 标记准确', () => {
  const list = [make('a'), make('b')];
  const { list: next, activeId, removed } = withDeletedCharacter(list, 'a', 'a');
  assert.equal(removed, true);
  assert.equal(next.some(c => c.id === 'a'), false);
  assert.equal(activeId, 'default');
  const noop = withDeletedCharacter(list, 'zzz', 'a');
  assert.equal(noop.removed, false);
  assert.equal(noop.activeId, 'a');
});

test('withPinnedCharacter：置顶与取消置顶，未命中 found=false', () => {
  const list = [make('a'), make('b')];
  const pinned = withPinnedCharacter(list, 'a', true);
  assert.equal(pinned.found, true);
  assert.equal(pinned.character.pinned, true);
  const unpinned = withPinnedCharacter(list, 'a', false);
  assert.equal(unpinned.character.pinned, false);
  assert.equal(withPinnedCharacter(list, 'zzz', true).found, false);
});

test('withDeletedCharacters：批量删除，删空时补内置卡', () => {
  const list = [make('a'), make('b'), make('c')];
  const partial = withDeletedCharacters(list, ['a', 'b'], 'a');
  assert.equal(partial.removedCount, 2);
  assert.equal(partial.activeId, 'default');
  const all = withDeletedCharacters(list, ['a', 'b', 'c'], 'a');
  assert.equal(all.removedCount, 3);
  assert.equal(all.list.length, 1);
  assert.equal(all.list[0].id, 'default');
});

test('describeDefaultArtwork：仅默认角色且字段为空时才补内置图', () => {
  const base = { id: 'default', avatarUri: '', bgUri: '', defaultId: 'default' };
  assert.deepEqual(describeDefaultArtwork(base), { avatar: true, bg: true });
  // 用户已自定义：不再补
  assert.deepEqual(
    describeDefaultArtwork({ ...base, avatarUri: 'file:///a.jpg', bgUri: 'file:///b.jpg' }),
    { avatar: false, bg: false }
  );
  // 只自定义了头像：背景仍补
  assert.deepEqual(
    describeDefaultArtwork({ ...base, avatarUri: 'file:///a.jpg' }),
    { avatar: false, bg: true }
  );
  // 非默认角色：一律不补
  assert.deepEqual(
    describeDefaultArtwork({ id: 'other', avatarUri: '', bgUri: '', defaultId: 'default' }),
    { avatar: false, bg: false }
  );
  // 空 defaultId：不补
  assert.deepEqual(
    describeDefaultArtwork({ id: 'default', avatarUri: '', bgUri: '', defaultId: '' }),
    { avatar: false, bg: false }
  );
  // 空白字符串视同空
  assert.deepEqual(
    describeDefaultArtwork({ ...base, avatarUri: '   ' }),
    { avatar: true, bg: true }
  );
});

test('runWithRollback：成功不改动，失败回滚并抛出原错误', async () => {
  let restored = null;
  await runWithRollback('snap', s => { restored = s; }, async () => {});
  assert.equal(restored, null);
  const boom = new Error('写入失败');
  await assert.rejects(
    runWithRollback('snap', s => { restored = s; }, async () => { throw boom; }),
    err => err === boom
  );
  assert.equal(restored, 'snap');
});
