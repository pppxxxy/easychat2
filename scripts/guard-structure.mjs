// 结构守卫：防止 src/ 根目录散文件再次膨胀 + 棘轮驱动收敛。
//
// 背景：src/ 根曾累积到 80+ 个文件（"先放根目录以后再归"的产物）。清理是
// 一次性动作，真正的防复发是在 PR 阶段拦住新文件继续往根丢。因此这里设一个
// 根目录 .js 文件数的上限，超过就失败。
//
// 棘轮协议（2026-10-07 快赢4 启动）：阈值 = 当前实际值，不再留缓冲——
// - 新增根文件 → 直接失败（先把新文件归域，或迁走一个既有根文件做净零交换）；
// - 每完成一批归域迁移 → 把 MAX_ROOT_FILES 下调到新的实际值（随手随迁）；
// - 上调阈值 = 棘轮失效，禁止；确需放宽必须在本文件说明理由并经用户确认。

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_ROOT_FILES = 33;

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

const rootFiles = readdirSync(srcDir).filter(name => name.endsWith('.js'));

if (rootFiles.length > MAX_ROOT_FILES) {
  console.error(
    `[guard:structure] src/ 根目录有 ${rootFiles.length} 个 .js 文件，超过上限 ${MAX_ROOT_FILES}。\n`
    + '新文件请按领域放进既有子目录（如 src/chat/、src/storage/、src/books/），\n'
    + '不要继续堆在 src/ 根。若确需放宽，请同步上调 scripts/guard-structure.mjs 的 MAX_ROOT_FILES 并说明理由。'
  );
  process.exit(1);
}

if (rootFiles.length < MAX_ROOT_FILES) {
  console.log(
    `[guard:structure] 提示：根文件 ${rootFiles.length} 个已低于上限 ${MAX_ROOT_FILES}，`
    + '请随本批迁移把 MAX_ROOT_FILES 下调到实际值（棘轮只许收紧）。'
  );
}
console.log(`[guard:structure] ok：src/ 根目录 ${rootFiles.length} 个 .js（上限 ${MAX_ROOT_FILES}）。`);

// ---- storage.js 门面导入禁令（2026-10-07 快赢1）----
// storage.js 已退役为纯转发（仅供测试加载器使用），应用代码一律直达 storage/<域>.js。
// 拦三类引用：静态 import、动态 import()、惰性 require()。门面自身与 tests/ 不在扫描范围。
const FACADE_RE = /(?:from\s+'[^']*storage\.js'\s*;|await\s+import\('[^']*storage\.js'\)|require\('[^']*storage\.js'\))/;
const facadePath = path.join(srcDir, 'storage.js');
const offenders = [];
function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
for (const file of collectJsFiles(srcDir).concat([path.join(here, '..', 'App.js')])) {
  if (path.resolve(file) === path.resolve(facadePath)) continue;
  if (FACADE_RE.test(readFileSync(file, 'utf8'))) {
    offenders.push(path.relative(path.join(here, '..'), file));
  }
}
if (offenders.length > 0) {
  console.error(
    '[guard:structure] 以下文件仍从 storage.js 门面导入：\n'
    + offenders.map(f => `  ${f}`).join('\n')
    + '\n应用代码必须直接 import 对应的 storage/<域>.js 模块（storage.js 仅剩测试加载器入口）。'
  );
  process.exit(1);
}
console.log('[guard:structure] ok：storage.js 门面导入禁令通过。');

// ---- 工作区单屏装配禁令（2026-10-08 Stage 1）----
// 工作区只能有一层 Modal：设置页挂 WorkspaceScreen，四个领域面板由它内部按需渲染。
// 此前设置页同时挂 WorkspaceChat 与 WorkspacePanel 两个平级 Modal，点链接再掀内部 viewer，
// 形成三层 z 轴堆叠（用户截图「历史改动盖在工作区上面」的根因）。这条规则拦住回退。
const settingsScreenPath = path.join(srcDir, 'SettingsScreen.js');
const settingsSource = readFileSync(settingsScreenPath, 'utf8');
const WORKSPACE_MODAL_RE = /from\s+'[^']*(?:WorkspacePanel|WorkspaceChat)\.js'/;
if (WORKSPACE_MODAL_RE.test(settingsSource)) {
  console.error(
    '[guard:structure] SettingsScreen.js 仍在直接引入 WorkspacePanel/WorkspaceChat。\n'
    + '工作区必须只挂一个 WorkspaceScreen（workspace/screen/WorkspaceScreen.js），\n'
    + '聊天/文件/GitHub/设置都是它内部的面板——否则三层 Modal 堆叠会复发。'
  );
  process.exit(1);
}
if (!/from\s+'[^']*workspace\/screen\/WorkspaceScreen\.js'/.test(settingsSource)) {
  console.error(
    '[guard:structure] SettingsScreen.js 未挂 WorkspaceScreen（工作区单屏）。'
    + '工作区入口必须走 workspace/screen/WorkspaceScreen.js。'
  );
  process.exit(1);
}
console.log('[guard:structure] ok：工作区单屏装配（SettingsScreen → WorkspaceScreen）。');

