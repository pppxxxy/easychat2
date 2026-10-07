// 结构守卫：防止 src/ 根目录散文件再次膨胀。
//
// 背景：src/ 根曾累积到 80+ 个文件（"先放根目录以后再归"的产物）。清理是
// 一次性动作，真正的防复发是在 PR 阶段拦住新文件继续往根丢。因此这里设一个
// 根目录 .js 文件数的上限，超过就失败。
//
// 阈值维护：`src/` 根目录需要保留各业务 Screen 入口（ChatScreen / CharacterScreen
// / SettingsScreen / ExtensionScreen ...）与少数顶层纯函数，所以阈值不是 0，也不是
// 任意小值。按「当前实际值 + 少量缓冲」设置；每完成一批归域迁移后，把阈值下调到
// 新的实际值 + 缓冲。

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_ROOT_FILES = 36;

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
