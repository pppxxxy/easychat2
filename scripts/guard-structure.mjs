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
//
// 2026-10-08 Stage 5：WorkspacePanel.js 迁至 workspace/screen/FilesPanel.js，33 → 32。

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_ROOT_FILES = 32;

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

// ---- 工作区面板禁止自套 Modal（2026-10-08 Stage 5）----
// 四个领域面板（对话/文件/GitHub/设置）都是 WorkspaceScreen 内部的 View，
// 唯一的一层 Modal 在 WorkspaceScreen。面板自己再包一层 Modal 就是 z 轴堆叠复发。
const screenDir = path.join(srcDir, 'workspace', 'screen');
const panelFiles = readdirSync(screenDir).filter(name => name.endsWith('.js') && name !== 'WorkspaceScreen.js');
const selfWrapped = [];
for (const name of panelFiles) {
  const source = readFileSync(path.join(screenDir, name), 'utf8');
  if (/<Modal\s+visible=\{visible\}/.test(source)) selfWrapped.push(name);
}
if (selfWrapped.length > 0) {
  console.error(
    '[guard:structure] 以下工作区面板仍自套 Modal：\n'
    + selfWrapped.map(f => `  src/workspace/screen/${f}`).join('\n')
    + '\n面板必须是 WorkspaceScreen 内的 View（唯一 Modal 在 WorkspaceScreen）。'
  );
  process.exit(1);
}
console.log('[guard:structure] ok：工作区面板未自套 Modal。');

// ---- 架构策略：文件行数棘轮（Z 系采纳 #2）----
// 背景：easychat2 有 16 个文件超过 800 行（ChatScreen 3062 行），单文件过大让评审、
// 测试与并发修改都变难。一次性拆完不现实，所以用棘轮：存量记进 architecture-baseline.json，
// 只许减不许增；新文件一律不得超上限。（对照 zai-org/ZCode 的 architecture-policy.yaml。）
const baselinePath = path.join(here, '..', 'architecture-baseline.json');
const policy = JSON.parse(readFileSync(baselinePath, 'utf8'));
const MAX_FILE_LINES = Number(policy.maxFileLines) || 800;
const excludedPaths = Array.isArray(policy.excludedPaths) ? policy.excludedPaths : [];
const fileLineBaseline = policy.fileLineBaseline || {};
const repoRoot = path.join(here, '..');
const relPath = f => path.relative(repoRoot, f).split(path.sep).join('/');
// 行数口径与 `wc -l` 一致（结尾换行不算一行）。
const countLines = src => src.split('\n').length - (src.endsWith('\n') ? 1 : 0);

const growth = [];
const newOversize = [];
const shrank = [];
for (const file of collectJsFiles(srcDir).concat([path.join(repoRoot, 'App.js')])) {
  const rel = relPath(file);
  if (excludedPaths.some(prefix => rel.startsWith(prefix))) continue;
  const lines = countLines(readFileSync(file, 'utf8'));
  const limit = fileLineBaseline[rel];
  if (limit !== undefined) {
    if (lines > limit) growth.push(`${rel}：${lines} 行 > 基线 ${limit}`);
    else if (lines <= MAX_FILE_LINES) shrank.push(`${rel}：${lines} 行已达上限，请从基线移除`);
  } else if (lines > MAX_FILE_LINES) {
    newOversize.push(`${rel}：${lines} 行 > 上限 ${MAX_FILE_LINES}`);
  }
}
if (growth.length > 0) {
  console.error(
    '[guard:structure] 以下文件超出各自基线行数（棘轮只许收紧）：\n'
    + growth.map(x => `  ${x}`).join('\n')
    + '\n请把改动拆到子模块，或随本次拆分同步下调 architecture-baseline.json。'
  );
  process.exit(1);
}
if (newOversize.length > 0) {
  console.error(
    `[guard:structure] 以下文件超过行数上限 ${MAX_FILE_LINES}：\n`
    + newOversize.map(x => `  ${x}`).join('\n')
    + '\n新文件请拆成更小的模块；确需放宽必须在本文件说明理由并经用户确认。'
  );
  process.exit(1);
}
if (shrank.length > 0) {
  console.log(
    '[guard:structure] 提示：以下文件已达标，请从 architecture-baseline.json 移除：\n'
    + shrank.map(x => `  ${x}`).join('\n')
  );
}
console.log(
  `[guard:structure] ok：文件行数棘轮（上限 ${MAX_FILE_LINES}，基线 ${Object.keys(fileLineBaseline).length} 个）。`
);

// ---- 架构策略：禁止模块循环依赖（Z 系采纳 #2）----
// ESM 循环依赖会让初始化顺序变得不可预测（storage.js 的拆分正是为了消循环）。
// 这里对 src/**/*.js + App.js 建导入图并检出环。扫描前先剥离注释——否则注释里
// 出现的 `from './x.js'` 会被误判（本仓 onboarding/disclaimer.js 就有一处）。
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

const IMPORT_RE = /(?:from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|require\(\s*['"](\.[^'"]+)['"]\s*\))/g;
const allFiles = collectJsFiles(srcDir).concat([path.join(repoRoot, 'App.js')]);
const fileSet = new Set(allFiles.map(f => path.resolve(f)));
const graph = new Map();
for (const file of allFiles) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const deps = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(src))) {
    const spec = match[1] || match[2] || match[3];
    let resolved = path.resolve(path.dirname(file), spec);
    if (!fileSet.has(resolved)) {
      if (fileSet.has(`${resolved}.js`)) resolved = `${resolved}.js`;
      else if (fileSet.has(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
      else continue;
    }
    deps.push(resolved);
  }
  graph.set(path.resolve(file), deps);
}
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
const cycles = [];
function visitCycle(node, stack) {
  color.set(node, GRAY);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    const seen = color.get(dep) || WHITE;
    if (seen === GRAY) cycles.push(stack.slice(stack.indexOf(dep)).concat(dep));
    else if (seen === WHITE) visitCycle(dep, stack);
  }
  stack.pop();
  color.set(node, BLACK);
}
for (const node of graph.keys()) {
  if ((color.get(node) || WHITE) === WHITE) visitCycle(node, []);
}
if (cycles.length > 0) {
  console.error(
    '[guard:structure] 检出模块循环依赖：\n'
    + cycles.map(chain => `  ${chain.map(relPath).join(' -> ')}`).join('\n')
    + '\n请打破环：把公共依赖抽到第三方模块，或改用参数注入。'
  );
  process.exit(1);
}
console.log('[guard:structure] ok：无模块循环依赖。');


