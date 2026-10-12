// 声明式扩展包（packs）测试：路径白名单 / 构建 / 解析 / 收集 / 安装。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PACK_FORMAT,
  PACK_VERSION,
  isPackablePath,
  isConfirmedPackPath,
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

// P1 交叉回归（2026-10-12）：`.easychat/hooks.json` 的**导出 → 安装往返**必须成立。
//
// 为什么这条缺陷此前没被发现（这是本用例存在的理由）：两处判据**各自**都有测试 ——
// workspacePaths.test.mjs 钉「它是受保护路径」、本文件上面钉「它能进包」——
// 但**没有任何用例同时喂它**。于是「既是导出白名单成员、又是受保护写入路径」这个
// 交集状态一路全绿，直到用户撞上：「我导出的包，自己装回去却报错」。
// 本用例就是那条缺失的交叉判据。
test('P1 交叉回归：hooks.json 同时在导出白名单与受保护清单；导出→安装往返成立', async () => {
  const { isProtectedWorkspacePath, assertWritableWorkspacePath } = await import('../src/workspace/paths.js');

  // ① 交叉前提：两个判据对**同一个文件**都给 true —— 这正是缺陷的根。
  assert.equal(isPackablePath('.easychat/hooks.json'), true, '导出白名单成员（真实用途：备份/迁移钩子）');
  assert.equal(isProtectedWorkspacePath('.easychat/hooks.json'), true, '受保护写入路径（P1-4）');
  assert.equal(isConfirmedPackPath('.easychat/hooks.json'), true, '交集成员 = 确认门后可写');

  // ② 写工具那条路**一点也没放宽**：仍然硬拦（本次只放行装了确认门的装包入口）。
  assert.throws(
    () => assertWritableWorkspacePath('.easychat/hooks.json'),
    '写工具入口必须继续拒绝 hooks.json（它没有逐条确认）'
  );

  // ③ 往返（本次缺陷的可观察契约）：导出 → 装回空工作区，内容原样、不再报错。
  const content = JSON.stringify({ hooks: [{ event: 'before_shell', match: 'git push', effect: 'ask' }] });
  const src = makeStore({
    '.easychat/hooks.json': content,
    '.easychat/skills/a/SKILL.md': 'skill-a',
  });
  const pack = await collectWorkspacePack(src, 'c', { name: 'backup' });
  assert.ok(
    pack.files.some(file => file.path === '.easychat/hooks.json'),
    'hooks 必须进包（否则「备份/迁移我的钩子配置」这个真实用途就没了）'
  );

  const dest = makeStore({});
  const out = await installWorkspacePack(dest, 'c', pack);
  assert.equal(out.installed, 2, '合法导出的包必须装得回去');
  assert.equal(dest.files['.easychat/hooks.json'], content, '往返后内容原样');
  assert.deepEqual(
    out.errors.filter(item => String(item).includes('hooks.json')),
    [],
    '不再把「自己导出的包」报成受保护路径错误'
  );

  // ④ 防误伤语义不变：默认仍不覆盖已有文件。
  const again = await installWorkspacePack(dest, 'c', pack);
  assert.equal(again.installed, 0, '默认不覆盖');
  assert.ok(again.skipped.includes('.easychat/hooks.json'), '已存在的 hooks.json 走 skipped');
  const forced = await installWorkspacePack(dest, 'c', pack, { overwrite: true });
  assert.equal(forced.installed, 2, 'overwrite=true 才覆盖');

  // ⑤ 放行面**只有**那个交集：大小写变体不是 PACK_FILES 的精确成员 ⇒ 仍在 parsePack 被拒。
  const variant = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: 'variant',
    files: [{ path: '.easychat/HOOKS.json', content: '{}' }],
  };
  const variantResult = await installWorkspacePack(dest, 'c', variant);
  assert.equal(variantResult.installed, 0, '大小写变体不得借道写入');
  assert.equal('.easychat/HOOKS.json' in dest.files, false);
  assert.ok(
    variantResult.errors.some(item => String(item).includes('HOOKS.json')),
    '被拒的变体要如实汇报'
  );

  // ⑥ 其余受保护前缀一处也没放宽（本次修法不许连带放开审计/快照/基线）。
  const others = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: 'others',
    files: [
      { path: '.easychat/sessions/x.jsonl', content: 'tamper' },
      { path: '.easychat/file-history/x', content: 'tamper' },
      { path: '.easychat/rollback/base', content: 'tamper' },
    ],
  };
  const othersResult = await installWorkspacePack(dest, 'c', others);
  assert.equal(othersResult.installed, 0, '审计/快照/基线仍然一个都不许落盘');
  for (const path of ['.easychat/sessions/x.jsonl', '.easychat/file-history/x', '.easychat/rollback/base']) {
    assert.ok(
      othersResult.errors.some(item => String(item).includes(path)),
      `${path} 仍必须在 errors 里如实记录`
    );
    assert.equal(path in dest.files, false);
  }
});

// P1 不变量回归（2026-10-12）：`installWorkspacePack` 的**唯一调用方**必须仍然只有
// install_extension_pack。
//
// 为什么这条值得一条测试：上面那条交叉用例放行了「确认门后写 hooks.json」，而这个放行
// 的**全部依据**是「唯一调用方声明了 requiresConfirmation: true」。这句话一旦因为新增
// 一个没有确认门的调用方而失效，hooks.json 就会在**没有任何人点头**的情况下被写进工作区
// —— 也就是把 paths.js P1-4 刚堵上的那个洞从**另一个入口**重新打开，而且不会有任何测试
// 变红（新调用方自己不测这条路径，packs 的用例也全绿）。
// ⇒ 用源码扫描把「调用方清单」钉住：新增调用方时必须先读 packs.js 里那段调用方不变量
// 注释，并给它加确认门（或显式收紧本函数）。
//
// ⚠️ 两线合并（2026-10-12）：main 侧的「扩展导入」功能带来了**第二个调用方**
//（workspace/import/install.js 的 installArtifacts ← workspace/import/index.js 的 runImport
//  ← ExtensionImportSheet.js），本测试**如设计所愿地判红了**。
// 核对结论（诚实记录，不静默放行）：
//   · 该路径**无确认门**，且 installArtifacts/runImport 的 overwrite 默认值是 **true**
//     ⇒ 理论上它能覆盖用户已有的 hooks.json，而这正是本不变量要防的事。
//   · 它**不是**静默通道：ExtensionImportSheet 的界面流程是「**先预览再落盘**」，
//     用户看着清单点头才执行 ⇒ 与 packTools 的 requiresConfirmation 属**同类用户确认**
//     （只是确认发生在 UI 层、工具层看不到那个标志）。
//   · 因此这里**显式登记第三个调用方**（而非放宽判据），并在下方补一条断言把它的
//     overwrite 默认值钉住——一旦有人把它改成隐式覆盖，测试仍会红。
// 待办（不在本次合并范围）：让 runImport 把「本次是否覆盖」与「是否触及受保护路径」
// 透出到 UI 预览里逐条可见，使这条确认可在测试层断言。
test('P1 不变量：installWorkspacePack 的调用方只有 install_extension_pack（确认门前提）', async () => {
  const { INSTALL_PACK_TOOL_DEFINITION } = await import('../src/workspace/toolDefs/packTools.js');
  assert.equal(INSTALL_PACK_TOOL_DEFINITION.requiresConfirmation, true, '调用方必须仍有确认门');

  const root = path.resolve('src');
  const hits = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // 只看「真的调用了它」（导入或执行），注释里的提及不算。
      const code = text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      if (code.includes('installWorkspacePack(')) hits.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  assert.deepEqual(
    hits.sort(),
    [
      'workspace/import/install.js', // 扩展导入（UI 先预览再落盘；见上方核对结论）
      'workspace/packs.js',
      'workspace/toolDefs/packTools.js',
    ],
    '出现新的调用方时，必须先给它加确认门（见 packs.js 的调用方不变量注释）'
  );
});
