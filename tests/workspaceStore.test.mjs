import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  listTruncationNotice,
  createWorkspaceDirectory,
  deleteWorkspaceDirectory,
  moveWorkspaceDirectory,
  editWorkspaceFile,
  listWorkspaceFiles,
  listWorkspaceFilesDetailed,
  readWorkspaceFile,
  WORKSPACE_LIMITS,
  writeWorkspaceBinaryFile,
  writeWorkspaceFile,
} from '../src/workspace/store.js';
import { SAF_LIMITS } from '../src/workspace/safStore.js';

function createMemoryFs() {
  const entries = new Map();
  const api = {
    documentDirectory: '/doc/',
    async getInfoAsync(uri) {
      const key = entries.has(uri) ? uri : (entries.has(`${uri}/`) ? `${uri}/` : null);
      if (!key) return { exists: false };
      return { exists: true, isDirectory: entries.get(key).type === 'dir' };
    },
    async makeDirectoryAsync(uri, options) {
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      if (options && options.intermediates) {
        // 真实 expo makeDirectoryAsync({intermediates:true}) 会把每一级父目录都建出来。
        let acc = '';
        for (const part of full.split('/').filter(Boolean)) {
          acc += `/${part}`;
          entries.set(`${acc}/`, { type: 'dir' });
        }
        return;
      }
      entries.set(full, { type: 'dir' });
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      // 真实 readDirectoryAsync 只在**目录本身不存在**时抛（legacy 侧 ENOENT / 不是目录）；
      // 存在的空目录返回 []。此前这里对空目录也抛 ENOENT —— 「空」与「读不到」同形，
      // 正是 F2 删除守卫那个「读失败当空目录 ⇒ 递归删整棵树」缺陷的桩版本。
      if (!entries.has(prefix)) throw new Error('ENOENT');
      const names = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).replace(/\/$/, '');
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      return [...names];
    },
    async readAsStringAsync(uri) {
      const entry = entries.get(uri);
      if (!entry || entry.type !== 'file') throw new Error('ENOENT');
      return entry.content;
    },
    async writeAsStringAsync(uri, text) {
      entries.set(uri, { type: 'file', content: String(text) });
    },
    seedFile(uri, content) {
      api.makeDirectoryAsync(uri.slice(0, uri.lastIndexOf('/') + 1));
      entries.set(uri, { type: 'file', content });
    },
    async moveAsync({ from, to }) {
      const fromPrefix = from.endsWith('/') ? from : `${from}/`;
      const toPrefix = to.endsWith('/') ? to : `${to}/`;
      const moves = [];
      for (const [key, value] of entries.entries()) {
        if (key === from) moves.push([key, to, value]);
        else if (key.startsWith(fromPrefix)) moves.push([key, `${toPrefix}${key.slice(fromPrefix.length)}`, value]);
      }
      if (moves.length === 0) throw new Error('ENOENT');
      for (const [key] of moves) entries.delete(key);
      for (const [, target, value] of moves) entries.set(target, value);
    },
    async deleteAsync(uri, options) {
      // 目录的 key 带尾斜杠；幂等语义（idempotent）下不存在不抛错——与 expo 一致。
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      const found = entries.has(uri) || entries.has(full);
      if (!found && !(options && options.idempotent)) throw new Error('ENOENT');
      entries.delete(uri);
      entries.delete(full);
    },
  };
  return api;
}

const root = '/doc/workspace/';

test('write→read 往返并自动建目录', async () => {
  const fileSystem = createMemoryFs();
  const written = await writeWorkspaceFile({
    root, characterId: 'c1', path: 'notes/a.md', content: '# 标题', fileSystem,
  });
  assert.deepEqual(written, { path: 'notes/a.md', length: 4 });
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'notes/a.md', fileSystem });
  assert.deepEqual(read, { path: 'notes/a.md', content: '# 标题', truncated: false, offset: 0, total: 4 });
});

test('list 递归、目录标记 /、过滤非白名单扩展名', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', content: 'a', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'sub/b.md', content: 'b', fileSystem });
  fileSystem.seedFile('/doc/workspace/c1/sub/c.png', 'binary');
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(files, ['a.txt', 'sub/', 'sub/b.md']);
});

test('list 指定 subdir 只列该子树', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'sub/b.md', content: 'b', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem, subdir: 'sub' });
  assert.deepEqual(files, ['sub/b.md']);
});

// P1 回归（2026-10-11）：模型不得从列表里看到内部审计/快照/中间产物。
//
// 事故形态：listWorkspaceFiles 只藏了 file-history 与 board，`.easychat/sessions/`
//（E4 会话事件流）、`.easychat/rollback/`（H3 推送基线）、`.task_outputs/`（O1 落盘结果）
// 全在列表里——模型读得到审计流与回滚基线，把它们当项目内容分析。
test('P1 回归：内部审计/快照/落盘目录不进列表（file-history / board / sessions / rollback / .task_outputs）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'README.md', content: '# hi', fileSystem });
  const hidden = [
    '.easychat/sessions/s1.jsonl',
    '.easychat/file-history/index.json',
    '.easychat/rollback/1700000000000.json',
    '.easychat/board/board.json',
    '.task_outputs/index.json',
    '.task_outputs/tool-results/r1.txt',
  ];
  for (const path of hidden) {
    await writeWorkspaceFile({ root, characterId: 'c1', path, content: '{"secret":1}', fileSystem });
  }
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  // `.easychat/` 目录条目本身仍在（里面有 hooks/skills/agents 这些**可见**的 agent 资产，
  // 藏掉目录会让模型找不到它们）；隐形的是内部子目录里的文件。
  assert.deepEqual(files, ['.easychat/', 'README.md'], `内部文件必须隐形，实际列出：${files.join(', ')}`);
  assert.equal(files.some(entry => entry.startsWith('.task_outputs')), false,
    '只装内部文件的 .task_outputs/ 连目录条目都不出现');
  // 仍然不误伤相邻的 agent 资产
  await writeWorkspaceFile({ root, characterId: 'c1', path: '.easychat/hooks.json', content: '{}', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: '.easychat/skills/x/SKILL.md', content: 's', fileSystem });
  const after = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(after, [
    '.easychat/',
    '.easychat/hooks.json',
    '.easychat/skills/',
    '.easychat/skills/x/',
    '.easychat/skills/x/SKILL.md',
    'README.md',
  ], 'agent 自己的资产照旧可见（只有内部审计/快照目录隐形）');
  // 隐形的是**枚举**不是读取：.task_outputs 的指针契约要求模型能按路径精读
  const persisted = await readWorkspaceFile({
    root, characterId: 'c1', path: '.task_outputs/tool-results/r1.txt', fileSystem,
  });
  assert.equal(persisted.content, '{"secret":1}', '按路径仍可读取（O1 指针契约）');
});

test('P1 回归：SAF 后端与 legacy 后端共用同一份隐形判据（不再各写一份）', () => {
  const safSource = fs.readFileSync(path.resolve('src/workspace/safStore.js'), 'utf8');
  const legacySource = fs.readFileSync(path.resolve('src/workspace/store.js'), 'utf8');
  for (const [name, source] of [['safStore.js', safSource], ['store.js', legacySource]]) {
    assert.ok(source.includes('isHiddenListEntry'), `${name} 必须用共享判据 isHiddenListEntry`);
    assert.equal(source.includes('hiddenPrefix'), false, `${name} 不得再自带一份隐形清单`);
  }
});

test('list 不存在的沙盒返回空数组', async () => {
  const fileSystem = createMemoryFs();
  assert.deepEqual(await listWorkspaceFiles({ root, characterId: 'nobody', fileSystem }), []);
});

test('read 缺失/目录/越界/非白名单均抛错', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'missing.txt', fileSystem }),
    /文件不存在/,
  );
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'a.png', fileSystem }),
    /只能读写文本文件/,
  );
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: '../x.txt', fileSystem }),
    /越出工作区/,
  );
});

test('write 拒绝越界与非白名单扩展名', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: '../x.txt', content: 'x', fileSystem }),
    /越出工作区/,
  );
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: 'a.png', content: 'x', fileSystem }),
    /只能读写文本文件/,
  );
});

test('read 超过 maxChars 时截断', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', content: '0123456789', fileSystem });
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'a.txt', fileSystem, maxChars: 4 });
  assert.deepEqual(read, { path: 'a.txt', content: '0123', truncated: true, offset: 0, total: 10, nextOffset: 4 });
});

test('二进制写入 .docx 可被 list 看到，但 read 拒绝', async () => {
  const fileSystem = createMemoryFs();
  const written = await writeWorkspaceBinaryFile({
    root, characterId: 'c1', path: 'report.docx', base64: 'UEsDBAo=', fileSystem,
  });
  assert.deepEqual(written, { path: 'report.docx', base64Length: 8 });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.deepEqual(files, ['report.docx']);
  await assert.rejects(
    readWorkspaceFile({ root, characterId: 'c1', path: 'report.docx', fileSystem }),
    /只能读写文本文件/,
  );
});

test('write：父路径被同名文件占用时给出明确错误，不裸奔 ENOTDIR', async () => {
  const fileSystem = {
    async getInfoAsync(uri) {
      if (uri === `${root}c1/notes/`) return { exists: true, isDirectory: false };
      if (uri === `${root}c1/`) return { exists: true, isDirectory: true };
      return { exists: false };
    },
    async makeDirectoryAsync() { throw new Error('父路径被占用时不该尝试建目录'); },
    async writeAsStringAsync() { throw new Error('父路径被占用时不该写入'); },
    async readAsStringAsync() { throw new Error('不该读'); },
  };
  await assert.rejects(
    writeWorkspaceFile({ root, characterId: 'c1', path: 'notes/a.md', content: 'x', fileSystem }),
    /已被同名文件占用/,
  );
});

test('list：深路径文件不再被 MAX_DEPTH 藏掉（6 → 12）', async () => {
  const fileSystem = createMemoryFs();
  const deep = 'repos/demo/main/src/i18n/locales/zh-CN/app.js';
  await writeWorkspaceFile({ root, characterId: 'c1', path: deep, content: 'export default {}', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes(deep), '8 段深的真实项目路径必须可见');
});

test('缺少 fileSystem 注入时抛错', async () => {
  await assert.rejects(
    listWorkspaceFiles({ root, characterId: 'c1' }),
    /缺少 fileSystem 注入/,
  );
});
test('createWorkspaceDirectory：建多级目录、可被 list 看到、幂等', async () => {
  const fileSystem = createMemoryFs();
  const first = await createWorkspaceDirectory({ root, characterId: 'c1', path: 'src/components', fileSystem });
  assert.equal(first.path, 'src/components/');
  assert.equal(first.created, true);
  const again = await createWorkspaceDirectory({ root, characterId: 'c1', path: 'src/components', fileSystem });
  assert.equal(again.created, false, '重复创建是幂等的');
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('src/'));
  assert.ok(files.includes('src/components/'));
});

test('createWorkspaceDirectory：越界路径被拒绝', async () => {
  const fileSystem = createMemoryFs();
  await assert.rejects(
    createWorkspaceDirectory({ root, characterId: 'c1', path: '../evil', fileSystem }),
    /越出工作区/,
  );
});

test('项目文件：源码扩展名可写可读可列（不再只限 txt/md）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'src/app.js', content: 'console.log(1)', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'index.html', content: '<h1>hi</h1>', fileSystem });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('src/app.js'));
  assert.ok(files.includes('index.html'));
  const read = await readWorkspaceFile({ root, characterId: 'c1', path: 'src/app.js', fileSystem });
  assert.equal(read.content, 'console.log(1)');
});

test('read 分段：offset/limit 与 nextOffset；越界 offset 归一到末尾', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', content: '0123456789', fileSystem });
  const head = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, maxChars: 4 });
  assert.deepEqual(head, { path: 'big.txt', content: '0123', truncated: true, offset: 0, total: 10, nextOffset: 4 });
  const tail = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, offset: 8, maxChars: 4 });
  assert.deepEqual(tail, { path: 'big.txt', content: '89', truncated: false, offset: 8, total: 10 });
  const beyond = await readWorkspaceFile({ root, characterId: 'c1', path: 'big.txt', fileSystem, offset: 999 });
  assert.deepEqual(beyond, { path: 'big.txt', content: '', truncated: false, offset: 10, total: 10 });
});

test('edit 守卫：超过读上限的文件可完整编辑；超过编辑上限明确拒绝且不落盘', async () => {
  const fileSystem = createMemoryFs();
  // 1MB+ 的文件：旧实现会带着截断内容回写、静默砍掉尾部——这里钉住完整编辑。
  const mid = `${'a'.repeat(1024 * 1024 + 10)}TAIL`;
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'mid.txt', content: mid, fileSystem });
  const edited = await editWorkspaceFile({ root, characterId: 'c1', path: 'mid.txt', find: 'TAIL', replace: 'DONE', fileSystem });
  assert.equal(edited.count, 1);
  const after = await fileSystem.readAsStringAsync(`${root}c1/mid.txt`);
  assert.ok(after.endsWith('DONE'), '替换必须生效');
  assert.equal(after.length, mid.length, '尾部不得被截断（长度守恒）');

  // 超过编辑上限：拒绝，且文件原样未动。
  const huge = 'b'.repeat(WORKSPACE_LIMITS.MAX_EDIT_CHARS + 1);
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'huge.txt', content: huge, fileSystem });
  await assert.rejects(
    editWorkspaceFile({ root, characterId: 'c1', path: 'huge.txt', find: 'b', replace: 'c', fileSystem }),
    /文件过大/
  );
  const untouched = await fileSystem.readAsStringAsync(`${root}c1/huge.txt`);
  assert.equal(untouched.length, huge.length, '拒绝后文件必须原样未动');
});
test('moveWorkspaceDirectory：目录改名（重命名仓库同步本地副本）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/old/main/a.js', content: 'a', fileSystem });
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/old/main/src/b.js', content: 'b', fileSystem });

  const moved = await moveWorkspaceDirectory({
    root, characterId: 'c1', from: 'repos/o/old', to: 'repos/o/renamed', fileSystem,
  });
  assert.deepEqual(moved, { from: 'repos/o/old', to: 'repos/o/renamed', moved: true });
  const files = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(files.includes('repos/o/renamed/main/a.js'), '文件跟到新目录');
  assert.ok(files.includes('repos/o/renamed/main/src/b.js'), '子目录结构保留');
  assert.ok(!files.some(name => name.startsWith('repos/o/old/')), '旧目录已不在');

  // 源不存在：moved:false，不报错。
  const missing = await moveWorkspaceDirectory({
    root, characterId: 'c1', from: 'repos/o/nope', to: 'repos/o/x', fileSystem,
  });
  assert.equal(missing.moved, false);

  // 目标已存在：拒绝覆盖。
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/o/taken/main/c.js', content: 'c', fileSystem });
  await assert.rejects(
    moveWorkspaceDirectory({ root, characterId: 'c1', from: 'repos/o/renamed', to: 'repos/o/taken', fileSystem }),
    /已存在/,
  );
  // 源是文件：明确拒绝。
  await assert.rejects(
    moveWorkspaceDirectory({ root, characterId: 'c1', from: 'repos/o/taken/main/c.js', to: 'repos/o/moved.js', fileSystem }),
    /不是目录/,
  );
});

test('F2 空目录可删（应用私有根后端）：非空拒绝 → 清空后可删；根拒绝', async () => {
  const fileSystem = createMemoryFs();
  // 先造一个非空目录：拒绝，且内容原样
  await writeWorkspaceFile({ root, characterId: 'c1', path: 'repos/easychat2/main/keep.txt', content: 'k', fileSystem });
  await assert.rejects(
    deleteWorkspaceDirectory({ root, characterId: 'c1', path: 'repos/easychat2/main/', fileSystem }),
    /dirNotEmpty|不为空|not empty/i,
  );
  const kept = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(kept.includes('repos/easychat2/main/keep.txt'), '拒绝后内容原样');

  // 清空 → 变空目录 → 可删
  await fileSystem.deleteAsync(`${root}c1/repos/easychat2/main/keep.txt`, { idempotent: true });
  const removed = await deleteWorkspaceDirectory({ root, characterId: 'c1', path: 'repos/easychat2/main/', fileSystem });
  assert.equal(removed.deleted, true);
  const after = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.equal(after.includes('repos/easychat2/main/'), false, '目标空目录真的没了（父目录保留）');

  // 根路径不可删、不存在的目录安全返回
  assert.equal((await deleteWorkspaceDirectory({ root, characterId: 'c1', path: '', fileSystem })).deleted, false);
  assert.equal((await deleteWorkspaceDirectory({ root, characterId: 'c1', path: 'nope/', fileSystem })).deleted, false);
});

// G1.7 列表截断告警（2026-10-10）：静默截断的清单会被当成完整事实推理
// （推送误删那类事故的放大器）。命中护栏时必须如实说「可能不完整」。
test('listTruncationNotice：命中文件数/深度护栏才提示，否则静默', () => {
  assert.equal(listTruncationNotice([]), '');
  assert.equal(listTruncationNotice(['a.txt', 'src/']), '');
  // 文件数到顶
  const atCap = Array.from({ length: WORKSPACE_LIMITS.MAX_FILES }, (_, i) => `f${i}.txt`);
  const capNotice = listTruncationNotice(atCap);
  assert.match(capNotice, /可能不完整/);
  assert.match(capNotice, new RegExp(String(WORKSPACE_LIMITS.MAX_FILES)));
  assert.match(capNotice, /subdir/);
  // 深度到顶的目录（它本身会被列出，但内容不再展开）
  const deepDir = `${Array.from({ length: WORKSPACE_LIMITS.MAX_DEPTH }, (_, i) => `d${i}`).join('/')}/`;
  const deepNotice = listTruncationNotice(['a.txt', deepDir]);
  assert.match(deepNotice, /深度上限/);
  assert.match(deepNotice, /1 个目录/);
  // 坏输入不炸
  assert.equal(listTruncationNotice(null), '');
  assert.equal(listTruncationNotice([null, undefined]), '');
});

// 🔴 P0 数据丢失回归（2026-10-10）：**读目录失败 ≠ 空目录**。
// deleteAsync 是递归语义：旧实现 catch 里 `children = []` ⇒ 读失败也过「空目录」门
// ⇒ 整棵非空目录树不可逆消失。对照 boardStore.js:42-48 的同款反模式修复。
test('F2 删除守卫：readDirectoryAsync 抛错时拒删（不得递归删掉非空目录树）', async () => {
  const fileSystem = createMemoryFs();
  await writeWorkspaceFile({
    root, characterId: 'c1', path: 'repos/o/r/main/keep.txt', content: 'k', fileSystem,
  });
  const dirUri = `${root}c1/repos/o/r/main/`;
  const originalReadDir = fileSystem.readDirectoryAsync.bind(fileSystem);
  // 模拟真实读失败：SAF 授权瞬时失效 / 目录被别的东西占着 —— 与「目录确实是空的」不同形。
  // 注意 normalize 会去掉尾斜杠，store 传下来的 uri 未必带 `/`（getInfo 那边两种都认）。
  fileSystem.readDirectoryAsync = async uri => {
    if (String(uri).replace(/\/$/, '') === dirUri.replace(/\/$/, '')) throw new Error('SAF 授权瞬时失效');
    return originalReadDir(uri);
  };

  const refused = await deleteWorkspaceDirectory({ root, characterId: 'c1', path: 'repos/o/r/main/', fileSystem });
  assert.equal(refused.deleted, false, '读不到目录内容 ⇒ 宁可拒删');
  assert.equal((await fileSystem.getInfoAsync(dirUri)).exists, true, '目录本身仍在');

  // 恢复可读后再看：里面的文件一个都没少（拒删是「不删」，不是「删了一半」）
  fileSystem.readDirectoryAsync = originalReadDir;
  const after = await listWorkspaceFiles({ root, characterId: 'c1', fileSystem });
  assert.ok(after.includes('repos/o/r/main/keep.txt'), '非空目录树完整保留');

  // 防过度修正：真正的空目录仍然可删（读得到 [] ⇒ 过门 ⇒ 删）
  await fileSystem.deleteAsync(`${dirUri}keep.txt`, { idempotent: true });
  const removed = await deleteWorkspaceDirectory({ root, characterId: 'c1', path: 'repos/o/r/main/', fileSystem });
  assert.equal(removed.deleted, true, '空目录照旧可删（不许因为怕误删就一律拒删）');
});

// 🔴 MAX_DEPTH 收敛（2026-10-10）：两个后端原先各写一份（store.js 12 / safStore.js 6），
// SAF 下深度 ≥7 的目录内容既不列出也不告警，而 listTruncationNotice 又写死 12。
test('护栏常量只有一份：两后端 MAX_DEPTH 同值（源码级 + 结构级）', () => {
  const legacy = fs.readFileSync(path.resolve('src/workspace/store.js'), 'utf8');
  const saf = fs.readFileSync(path.resolve('src/workspace/safStore.js'), 'utf8');
  assert.equal(/const MAX_DEPTH\s*=/.test(legacy), false, 'store.js 不得自带一份 MAX_DEPTH');
  assert.equal(/const MAX_DEPTH\s*=/.test(saf), false, 'safStore.js 不得自带一份 MAX_DEPTH（旧值 6）');
  assert.equal(WORKSPACE_LIMITS.MAX_DEPTH, SAF_LIMITS.MAX_DEPTH, '两后端深度上限必须同值');
  assert.equal(WORKSPACE_LIMITS, SAF_LIMITS, '两后端指的是同一份冻结常量');
  // 深度到顶必须置 truncated（原先只 return，静默截断）
  for (const [name, source] of [['store.js', legacy], ['safStore.js', saf]]) {
    assert.match(source, /if \(depth > MAX_DEPTH\) \{\s*state\.truncated = true;/, `${name} 深度截断要置 truncated`);
  }
});

test('listTruncationNotice：按**传入的生效值**判（不再写死 12）+ truncated 权威标记兜底', () => {
  const deep6 = `${Array.from({ length: 6 }, (_, i) => `d${i}`).join('/')}/`;
  // SAF 后端旧口径 6 层：同一份列表在 6 层判据下必须告警，且文案里是 6
  const six = listTruncationNotice(['a.txt', deep6], { maxDepth: 6 });
  assert.match(six, /6 层深度上限/);
  // 同一份列表在 12 层判据下不算深 —— 证明它读的是参数，不是模块内写死的常量
  assert.equal(listTruncationNotice(['a.txt', deep6], { maxDepth: 12 }), '');
  // 后端只给 truncated（无法按结果规模推断出是哪条护栏）时也必须告警，不得静默
  const fallback = listTruncationNotice(['a.txt'], { truncated: true, maxDepth: 6 });
  assert.match(fallback, /可能不完整/);
  assert.match(fallback, /6 层/);
  // truncated=false 且未命中护栏 → 静默（防过度告警）
  assert.equal(listTruncationNotice(['a.txt'], { truncated: false, maxDepth: 6 }), '');
});

test('legacy 后端：深度截断置 truncated（浅树不置，防过度告警）', async () => {
  const deepFs = createMemoryFs();
  const deepPath = `${Array.from({ length: WORKSPACE_LIMITS.MAX_DEPTH + 2 }, (_, i) => `d${i}`).join('/')}/deep.txt`;
  await writeWorkspaceFile({ root, characterId: 'c1', path: deepPath, content: 'x', fileSystem: deepFs });
  const deep = await listWorkspaceFilesDetailed({ root, characterId: 'c1', fileSystem: deepFs });
  assert.equal(deep.truncated, true, '超过深度上限必须置 truncated（原先静默 return）');
  assert.equal(deep.files.includes(deepPath), false, '超深文件本来就不列出');

  const shallowFs = createMemoryFs();
  const shallowPath = `${Array.from({ length: WORKSPACE_LIMITS.MAX_DEPTH }, (_, i) => `d${i}`).join('/')}/ok.txt`;
  await writeWorkspaceFile({ root, characterId: 'c1', path: shallowPath, content: 'x', fileSystem: shallowFs });
  const shallow = await listWorkspaceFilesDetailed({ root, characterId: 'c1', fileSystem: shallowFs });
  assert.equal(shallow.truncated, false, '没超上限不得谎报截断');
  assert.ok(shallow.files.includes(shallowPath), '正好在上限内的文件仍要列出');
});
