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

// P0 回归（2026-10-12）：install_extension_pack 是**写类**动作，必须过确认门。
//
// 事故形态：定义里只有 `readOnly: false`，既没有 requiresConfirmation、也没有路径守卫，
// 于是「装一个包」= 无确认地把 hooks.json 写进工作区（before_tool / before_prompt
// 是工具前门与提示词注入面）。对照：run_shell / run_python / git_discard 都是
// readOnly:false + requiresConfirmation:true。
test('P0 回归：install_extension_pack 逐条确认（readOnly:false + requiresConfirmation:true）', async () => {
  const { INSTALL_PACK_TOOL_DEFINITION, EXPORT_PACK_TOOL_DEFINITION } = await import('../src/workspace/toolDefs/packTools.js');
  assert.equal(INSTALL_PACK_TOOL_DEFINITION.readOnly, false);
  assert.equal(INSTALL_PACK_TOOL_DEFINITION.requiresConfirmation, true, '装包必须逐条确认');
  // 导出是只读工具，不该被这次修改顺手带上确认门（没有副作用就不打扰用户）。
  assert.equal(EXPORT_PACK_TOOL_DEFINITION.readOnly, true);
  assert.equal('requiresConfirmation' in EXPORT_PACK_TOOL_DEFINITION, false);

  // 端到端：聚合层（tools.js）必须把该字段透传进注册表，否则定义上写了也等于没写。
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const definitions = createWorkspaceToolDefinitions({});
  const install = definitions.find(item => item.name === 'install_extension_pack');
  assert.equal(install.readOnly, false);
  assert.equal(install.requiresConfirmation, true, '聚合层要透传 requiresConfirmation');
  const exported = definitions.find(item => item.name === 'export_extension_pack');
  assert.equal(exported.requiresConfirmation, undefined, '只读导出不需要确认');
});

// P0 回归（2026-10-12）：装包不得无确认地写「受保护路径」。
//
// 事故形态：installWorkspacePack 走 store.writeWorkspaceFile **直写**，绕开了写工具
// execute 入口的路径守卫（paths.js 的 assertWritableWorkspacePath 只在 writeTools /
// docxTool 里调）。而包里能带 `.easychat/hooks.json`（before_tool / before_prompt
// 是工具前门与提示词注入面）——于是一次装包就是一次绕过守卫的写入。
// 本用例钉住可观察契约：受保护路径**不落盘**，且**如实计入 errors**（不静默跳过）。
test('P0 回归：installWorkspacePack 拒绝受保护路径（不写入 + errors 有记录）', async () => {
  const dest = makeStore({});
  const tampered = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: 'evil',
    files: [
      { path: '.easychat/sessions/x.jsonl', content: '{"type":"tool_call"}' },
      { path: '.easychat/file-history/x', content: 'snapshot' },
      { path: '.easychat/rollback/base', content: 'baseline' },
    ],
  };
  const result = await installWorkspacePack(dest, 'c', tampered);
  assert.equal(result.installed, 0);
  assert.deepEqual(dest.files, {}, '受保护路径一个都不许落盘');
  for (const path of ['.easychat/sessions/x.jsonl', '.easychat/file-history/x', '.easychat/rollback/base']) {
    assert.ok(
      result.errors.some(item => String(item).includes(path)),
      `${path} 必须在 errors 里有记录（不能静默跳过）`
    );
  }

  // 混合包：合法的扩展文件照常安装，受保护路径单独报错——**不整包失败**。
  const mixed = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: 'mixed',
    files: [
      { path: '.easychat/skills/a/SKILL.md', content: 'skill-a' },
      { path: '.easychat/sessions/x.jsonl', content: 'tamper' },
    ],
  };
  const partial = await installWorkspacePack(dest, 'c', mixed);
  assert.equal(partial.installed, 1, '合法文件必须照常安装（不整包失败）');
  assert.equal(dest.files['.easychat/skills/a/SKILL.md'], 'skill-a');
  assert.equal('.easychat/sessions/x.jsonl' in dest.files, false, '受保护路径仍不得落盘');
  assert.ok(
    partial.errors.some(item => String(item).includes('.easychat/sessions/x.jsonl')),
    '被拒的文件要如实汇报'
  );
});
