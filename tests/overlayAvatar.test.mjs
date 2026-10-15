// FEAT-AC3：悬浮球头像三模式。
//
// 三层各测一部分：
//   纯层（overlayAvatarSource）—— Node 直测：三模式各自的 uri 解析、双值、归一。
//   存储叶子（overlayAvatar）—— babel + Module._load 打桩（照 musicPlayer.test.mjs
//     的做法：这些模块 import storage/io → expo-file-system，Node 直 import 会崩）。
//   原生（Kotlin 源码断言）—— 参数校验、降采样、静默回退。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  normalizeCharacterAvatarUri,
  resolveOverlayAvatarSource,
} from '../src/screenWatch/overlayAvatarSource.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// ---------- 纯层：三模式解析（任务书 P0-3）----------

test('resolveOverlayAvatarSource：default → 双值都空（回退 App 图标）', () => {
  assert.deepEqual(
    resolveOverlayAvatarSource({ mode: 'default', customUri: 'file://x.jpg', characterAvatarUri: 'file://c.jpg' }),
    { chatAvatarUri: '', workspaceAvatarUri: '' },
    '默认档必须忽略两个 uri（那是现状行为：App 图标）'
  );
});

test('resolveOverlayAvatarSource：custom → **两个 scope 都用同一张自定义图**', () => {
  const out = resolveOverlayAvatarSource({
    mode: 'custom',
    customUri: 'file:///data/overlay-avatar.jpg',
    characterAvatarUri: 'file:///data/char.jpg',
  });
  assert.equal(out.chatAvatarUri, 'file:///data/overlay-avatar.jpg');
  assert.equal(out.workspaceAvatarUri, 'file:///data/overlay-avatar.jpg',
    '用户选的是「这个 app 的头像」，切到工作区不该变回 App 图标');
});

test('resolveOverlayAvatarSource：character → 聊天用角色头像、工作区回退 App 图标', () => {
  const out = resolveOverlayAvatarSource({
    mode: 'character',
    customUri: 'file:///data/custom.jpg',
    characterAvatarUri: 'file:///data/char.jpg',
  });
  assert.equal(out.chatAvatarUri, 'file:///data/char.jpg');
  assert.equal(out.workspaceAvatarUri, '', '工作区 scove 回退 App 图标（角色头像在这里没意义）');
});

test('resolveOverlayAvatarSource：角色无头像 → 空串（原生回退 App 图标，不报错）', () => {
  for (const characterAvatarUri of ['', '   ', undefined, null]) {
    const out = resolveOverlayAvatarSource({ mode: 'character', characterAvatarUri });
    assert.equal(out.chatAvatarUri, '', `角色头像 ${JSON.stringify(characterAvatarUri)} 应解析为空`);
    assert.equal(out.workspaceAvatarUri, '');
  }
});

test('resolveOverlayAvatarSource：custom 但没选图 → 空串（不猜、不报错）', () => {
  const out = resolveOverlayAvatarSource({ mode: 'custom', customUri: '' });
  assert.deepEqual(out, { chatAvatarUri: '', workspaceAvatarUri: '' });
});

test('resolveOverlayAvatarSource：未知/缺失 mode → 按 default 处理', () => {
  for (const mode of ['nonsense', '', undefined, null, 123]) {
    assert.deepEqual(
      resolveOverlayAvatarSource({ mode, customUri: 'file://x.jpg' }),
      { chatAvatarUri: '', workspaceAvatarUri: '' },
      `mode=${JSON.stringify(mode)} 应按默认档`
    );
  }
});

test('resolveOverlayAvatarSource：uri 两侧空白被裁掉（脏数据不该透传到原生）', () => {
  const out = resolveOverlayAvatarSource({ mode: 'custom', customUri: '  file:///a.jpg  ' });
  assert.equal(out.chatAvatarUri, 'file:///a.jpg');
});

// ---------- 纯层：角色头像 uri 归一（任务书标"未核实"的那一项）----------

test('normalizeCharacterAvatarUri：已带 scheme 原样保留（file:// 与 content:// 都认）', () => {
  // 已核实：角色头像实际是 copyAsync 到 documentDirectory 的 file:// 绝对路径；
  // content:// 也交给原生 contentResolver（loadAvatar 先例两者都能读）。
  for (const uri of [
    'file:///data/user/0/pkg/files/avatars/a.jpg',
    'content://media/external/images/1',
    'https://example.com/a.jpg',
  ]) {
    assert.equal(normalizeCharacterAvatarUri(uri, 'file:///base/'), uri);
  }
});

test('normalizeCharacterAvatarUri：绝对路径补 file://；相对路径拼 documentDirectory', () => {
  const base = 'file:///data/user/0/pkg/files/';
  assert.equal(
    normalizeCharacterAvatarUri('/data/user/0/pkg/files/a.jpg', base),
    'file:///data/user/0/pkg/files/a.jpg'
  );
  assert.equal(
    normalizeCharacterAvatarUri('avatars/a.jpg', base),
    'file:///data/user/0/pkg/files/avatars/a.jpg'
  );
});

test('normalizeCharacterAvatarUri：空 → 空；相对路径无 base → 空（不猜一个读不了的 uri）', () => {
  assert.equal(normalizeCharacterAvatarUri('', 'file:///base/'), '');
  assert.equal(normalizeCharacterAvatarUri('   ', 'file:///base/'), '');
  assert.equal(normalizeCharacterAvatarUri('avatars/a.jpg', ''), '',
    '拿不到 base 时相对路径无法可靠还原 → 返回空交由调用方回退');
});

// ---------- 存储叶子（babel + Module._load 打桩）----------

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const leafPath = path.resolve('src/storage/settings/overlayAvatar.js');
const transformed = babel.transformSync(fs.readFileSync(leafPath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: leafPath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const failedGets = new Set();
const AsyncStorage = {
  getItem: async key => {
    if (failedGets.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  backupCorruptValue: async key => { store.set(`${key}__corrupt_backup`, store.get(key)); },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
};
const i18nStub = { tActive: key => key };
const originalLoad = Module._load;
Module._load = function patched(request) {
  const asString = String(request || '');
  // 注意：叶子用的是**相对**路径（'../io.js'），所以按后缀/包含匹配而不是全路径匹配。
  if (asString.includes('async-storage')) {
    // babel 的 CJS 互操作：`import AsyncStorage from '...'` 在 transformed 代码里
    // 走 _interopRequireDefault，只有带 __esModule 的对象才会取 .default。
    // 直接给 { default: AsyncStorage } 而不打 __esModule 会拿到整个对象
    //（表现为 setItem is not a function）。
    return { __esModule: true, default: AsyncStorage };
  }
  if (/(^|\/)io(\.js)?$/.test(asString) || asString.endsWith('io.js')) return ioStub;
  if (asString.includes('i18n/index') || asString.endsWith('i18n/index.js')) return i18nStub;
  return originalLoad.apply(this, arguments);
};

const leaf = (() => {
  const module_ = { exports: {} };
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', transformed);
  wrapper(module_.exports, require, module_, leafPath, path.dirname(leafPath));
  return module_.exports;
})();

test('存储叶子：非法 mode 回退 default，customUri 去空白截断', () => {
  const { normalizeOverlayAvatar, OVERLAY_AVATAR_MODES } = leaf;
  assert.deepEqual(OVERLAY_AVATAR_MODES, ['default', 'character', 'custom']);
  assert.deepEqual(normalizeOverlayAvatar(null), { mode: 'default', customUri: '' });
  assert.deepEqual(normalizeOverlayAvatar({ mode: 'nonsense', customUri: ' x ' }),
    { mode: 'default', customUri: 'x' });
  assert.deepEqual(normalizeOverlayAvatar({ mode: 'character' }), { mode: 'character', customUri: '' });
  // 数组/原语也走默认（形状判据同 thinking.js）
  assert.deepEqual(normalizeOverlayAvatar([]), { mode: 'default', customUri: '' });
  assert.deepEqual(normalizeOverlayAvatar('x'), { mode: 'default', customUri: '' });
  // 超长 uri 截断而不是整键丢弃
  const long = 'a'.repeat(2000);
  assert.equal(normalizeOverlayAvatar({ mode: 'custom', customUri: long }).customUri.length, 1024);
});

test('存储叶子：读写往返（含缺键回默认）', async () => {
  store.clear();
  failedGets.clear();
  const { getOverlayAvatarSettings, saveOverlayAvatarSettings } = leaf;
  assert.deepEqual(await getOverlayAvatarSettings(), { mode: 'default', customUri: '' }, '缺键 → 默认');
  await saveOverlayAvatarSettings({ mode: 'custom', customUri: 'file:///a.jpg' });
  assert.deepEqual(await getOverlayAvatarSettings(), { mode: 'custom', customUri: 'file:///a.jpg' });
  // 落盘形状确认（键名是契约）
  assert.ok(store.has('@easychat2_overlay_avatar'));
});

test('存储叶子：损坏值 → 读抛错、写拒绝（绝不用默认值整键覆盖）', async () => {
  store.clear();
  failedGets.clear();
  store.set('@easychat2_overlay_avatar', '{not json');
  const { getOverlayAvatarSettings, saveOverlayAvatarSettings } = leaf;
  await assert.rejects(() => getOverlayAvatarSettings(), /overlayAvatarReadFailed/);
  await assert.rejects(() => saveOverlayAvatarSettings({ mode: 'custom' }), /overlayAvatarReadFailed/);
  assert.equal(store.get('@easychat2_overlay_avatar'), '{not json', '损坏原值不得被覆盖');
});

test('存储叶子：形状坏（null/数组）也算损坏（第四态，不是"没设置过"）', async () => {
  store.clear();
  failedGets.clear();
  const { getOverlayAvatarSettings } = leaf;
  for (const bad of ['null', '[]', '"x"']) {
    store.set('@easychat2_overlay_avatar', bad);
    await assert.rejects(() => getOverlayAvatarSettings(), /overlayAvatarReadFailed/,
      `${bad} 应判损坏而不是折叠成默认值`);
  }
});

test.after(() => {
  Module._load = originalLoad;
});

// ---------- 原生（Kotlin 源码断言）----------

test('原生：setOverlayAvatar 存在、双值入参、失败 reject 而非崩', () => {
  const module_ = read('plugins/screenOverlay/android/ScreenOverlayModule.kt');
  assert.ok(module_.includes('fun setOverlayAvatar('), '模块方法已注册');
  assert.ok(module_.includes('"chatAvatarUri"') && module_.includes('"workspaceAvatarUri"'),
    '双值（scope 切换在原生侧发生，JS 一次推两个）');
  assert.match(module_, /fun setOverlayAvatar\([\s\S]{0,600}?catch \(e: Exception\)[\s\S]{0,200}?promise\.reject/,
    '失败要 reject 而非崩');
  // 导入 ReadableMap（否则编译不过）
  assert.ok(module_.includes('import com.facebook.react.bridge.ReadableMap'));
});

test('原生：头像加载走 contentResolver + 降采样（4000×3000 大图不掉帧）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('fun circularAvatarFromUri('), '有按 uri 加载的头像函数');
  // 与 ProactiveCore.loadAvatar 同一套读法（file:// 与 content:// 都能读）
  assert.ok(service.includes('contentResolver.openInputStream'), '走 contentResolver（先例：通知栏头像）');
  // 降采样：先 inJustDecodeBounds 读尺寸算 inSampleSize，再解码
  assert.ok(service.includes('inJustDecodeBounds = true'), '第一趟只读尺寸');
  assert.ok(service.includes('calculateInSampleSize'), '按目标边长算采样率');
  assert.match(service, /inSampleSize = calculateInSampleSize\(/);
});

test('原生：加载失败/uri 空/files 丢失 → 静默回退 App 图标（不弹错不崩）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('fun resolveBallDrawable('), '有「选图或回退」的解算');
  // uri 空或加载失败都回落到 App 图标
  assert.match(service, /if \(uri\.isNotBlank\(\)\)[\s\S]{0,300}?if \(fromUri != null\) return fromUri[\s\S]{0,120}?circularAppIcon\(size\)/,
    '取不到图必须回退 App 图标');
  // 加载异常被吞（不向上抛）
  assert.match(service, /fun circularAvatarFromUri\([\s\S]{0,1400}?catch \(error: Exception\)[\s\S]{0,200}?null/,
    '加载异常要吞掉并返回 null');
});

test('原生：scope 切换后重绘球（跟随角色模式的关键行为）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('fun setAvatarUris('), '双值入口存在');
  assert.match(service, /private fun toggleChatScope\(\)[\s\S]{0,400}?refreshBallAvatar\(\)/,
    'scope 切换必须刷新球（否则切完 scope 头像还是旧的）');
  assert.ok(service.includes('private fun refreshBallAvatar('), '刷新实现存在');
  // 双值字段与「按当前 scope 取值」
  assert.ok(service.includes('avatarChatUri') && service.includes('avatarWorkspaceUri'));
  assert.ok(service.includes('private fun activeAvatarUri('), '按 scope 选 uri');
});

test('JS 桥：setOverlayAvatar 在旧构建上安全降级（不支持 → false，不抛）', () => {
  const overlay = read('src/screenWatch/overlay.js');
  assert.ok(overlay.includes('export async function setOverlayAvatar('));
  assert.match(overlay, /typeof module\.setOverlayAvatar !== 'function'[\s\S]{0,80}?return false/,
    '方法缺失时返回 false');
});

test('设置卡：三选一 + custom 档的选图与稳定路径落盘', () => {
  const card = read('src/screenWatch/AvatarCard.js');
  for (const mode of ['default', 'character', 'custom']) {
    assert.ok(card.includes(`'${mode}'`), `缺少 ${mode} 档`);
  }
  // 同上：断言**真的调用了选择器**（只断言 includes 时，留个 import 就能蒙混）。
  assert.match(card, /await ImagePicker\.launchImageLibraryAsync\(/,
    '必须真的调起图片选择器（仓内先例 expo-image-picker）');
  // ⚠️ 必须断言**真的调用了**它，而不是「文件里出现过这个名字」——
  // 光断言 includes('copyOverlayAvatarFile') 时，把调用改成 `asset.uri` 仍然通过
  //（因为 import 行还在），等于放过「直接引用相册 uri」这条回归（注入验证抓到的）。
  assert.match(card, /await copyOverlayAvatarFile\(asset\.uri/,
    '必须把选中的图片复制到专属稳定路径（不引用相册 uri）');
  assert.match(card, /mode: 'custom', customUri: stableUri/,
    '落库的是复制后的稳定 uri，不是选择器返回的 uri');
  assert.ok(card.includes('pushOverlayAvatar'), '改完立即推原生（P0-3 第 2 条）');
  // 卡片已挂到看屏幕页
  const screen = read('src/screenWatch/ScreenWatchScreen.js');
  assert.ok(screen.includes('<AvatarCard />'), 'AvatarCard 已挂载');
});

test('设置卡：文案如实说明两 scope 差异（跟随角色在工作区显示 App 图标）', () => {
  for (const locale of ['zh-CN', 'en']) {
    const dict = read(`src/i18n/locales/${locale}/screenWatch.js`);
    assert.ok(dict.includes("'screenWatch.avatar.title'"), `${locale} 缺 title`);
    assert.ok(dict.includes("'screenWatch.avatar.mode.character'"), `${locale} 缺 character 档`);
    assert.ok(dict.includes("'screenWatch.avatar.pickFailed.title'"), `${locale} 缺选图失败文案`);
  }
  const zh = read('src/i18n/locales/zh-CN/screenWatch.js');
  assert.match(zh, /工作区模式下显示 App 图标/, '中文 hint 必须写明工作区回退 App 图标');
});
