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

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_ROOT_FILES = 85;

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
