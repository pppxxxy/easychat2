// 声明式扩展包（packs）测试：路径白名单 / 构建 / 解析 / 收集 / 安装。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACK_FORMAT,
  PACK_VERSION,
  isPackablePath,
  buildPack,
  parsePack,
  serializePack,
  collectWorkspacePack,
  installWorkspacePack,
} from '../src/workspace/packs.js';

function makeStore(files = {}) {
  return {
    files,
    async listWorkspaceFiles() {
      return Object.keys(files);
    },
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      return { content: files[path] };
    },
    async writeWorkspaceFile({ path, content }) {
      files[path] = content;
      return { path };
    },
  };
}

test('isPackablePath：扩展根放行，其它与路径穿越拒绝', () => {
  assert.equal(isPackablePath('.easychat/skills/x/SKILL.md'), true);
  assert.equal(isPackablePath('.easychat/skills/x/scripts/a.py'), true);
  assert.equal(isPackablePath('.easychat/commands/c.md'), true);
  assert.equal(isPackablePath('.easychat/agents/a.md'), true);
  assert.equal(isPackablePath('.easychat/teams/t.md'), true);
  assert.equal(isPackablePath('.easychat/hooks.json'), true);
  assert.equal(isPackablePath('.easychat/board/board.json'), false, '黑板不是扩展');
  assert.equal(isPackablePath('.easychat/file-history/x'), false);
  assert.equal(isPackablePath('notes.md'), false);
  assert.equal(isPackablePath('.easychat/skills/'), false, '目录不是文件');
  assert.equal(isPackablePath('.easychat/skills/../secret'), false, '拒绝穿越');
  assert.equal(isPackablePath(''), false);
});

test('buildPack：过滤非扩展文件；format/version 正确', () => {
  const pack = buildPack({
    name: '包',
    description: 'd',
    files: [
      { path: '.easychat/skills/a/SKILL.md', content: 'x' },
      { path: 'notes.md', content: 'y' },
    ],
  });
  assert.equal(pack.format, PACK_FORMAT);
  assert.equal(pack.version, PACK_VERSION);
  assert.equal(pack.files.length, 1);
  assert.equal(pack.files[0].path, '.easychat/skills/a/SKILL.md');
});

test('parsePack：合法往返；坏 JSON / 格式不符 / 版本过新 / 空包拒绝', () => {
  const pack = buildPack({ name: 'p', files: [{ path: '.easychat/commands/c.md', content: 'hi' }] });
  const round = parsePack(serializePack(pack));
  assert.equal(round.ok, true);
  assert.equal(round.pack.files[0].content, 'hi');

  assert.equal(parsePack('{坏').ok, false);
  assert.equal(parsePack({ format: 'other', version: 1, files: [{ path: '.easychat/commands/c.md', content: 'x' }] }).ok, false);
  assert.equal(parsePack({ format: PACK_FORMAT, version: 99, files: [{ path: '.easychat/commands/c.md', content: 'x' }] }).ok, false);
  assert.equal(parsePack({ format: PACK_FORMAT, version: 1, files: [] }).ok, false, '空包拒绝');
  assert.equal(parsePack(null).ok, false);
});

test('collectWorkspacePack / installWorkspacePack：往返；默认不覆盖，overwrite 才覆盖', async () => {
  const store = makeStore({
    '.easychat/skills/a/SKILL.md': 'skill-a',
    '.easychat/commands/c.md': 'cmd-c',
    'notes.md': 'not packed',
  });
  const pack = await collectWorkspacePack(store, 'c', { name: 'p' });
  assert.equal(pack.files.length, 2);
  assert.equal(pack.files.some(file => file.path === 'notes.md'), false, '非扩展文件不进包');

  const dest = makeStore({});
  const installed = await installWorkspacePack(dest, 'c', pack);
  assert.equal(installed.installed, 2);
  assert.equal(dest.files['.easychat/skills/a/SKILL.md'], 'skill-a');

  const again = await installWorkspacePack(dest, 'c', pack);
  assert.equal(again.installed, 0, '默认不覆盖');
  assert.equal(again.skipped.length, 2);

  dest.files['.easychat/commands/c.md'] = 'old';
  const forced = await installWorkspacePack(dest, 'c', pack, { overwrite: true });
  assert.equal(forced.installed, 2);
  assert.equal(dest.files['.easychat/commands/c.md'], 'cmd-c');
});

test('installWorkspacePack：坏包报错、无 store 报错', async () => {
  const bad = await installWorkspacePack(makeStore({}), 'c', 'nonsense');
  assert.equal(bad.installed, 0);
  assert.ok(bad.errors.length > 0);
  const noStore = await installWorkspacePack(null, 'c', buildPack({ files: [] }));
  assert.ok(noStore.errors.length > 0);
});
