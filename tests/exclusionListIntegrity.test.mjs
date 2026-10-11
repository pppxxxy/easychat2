// 排除清单不得指向**不存在**的文件（回归 2026-10-11 逐行审查 P2）。
//
// 背景：eslint.config.mjs 的 ignores 与 .c8rc.json 的 exclude 里都还留着
// `src/location/service.js`——那个文件**早已删除**（tests/locationWiring.test.mjs 明确断言
// 它不存在），全仓也没有任何引用。死条目本身无害，但它会掩盖未来：哪天有人新建一个同名
// 文件，它会被这两份清单**静默排除**（lint 不查、覆盖率不统计），而没有任何东西会提醒。
//
// 纪律：清单只减不增——文件删了就把条目一起删。本文件把这条纪律变成可执行的检查。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

// 只取 `ignores: [...]` 里的条目：config 里还有 files / globals 等数组，
// 混进来会把「新文件还没建」之类的正常情况误报成死条目。
// 注释里也会出现带引号的示例（如 `t('<key>')`），所以先剥掉行注释再取引号串。
function eslintIgnoreEntries() {
  const source = fs.readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8');
  const entries = [];
  for (const block of source.matchAll(/ignores:\s*\[([^\]]*)\]/g)) {
    const body = block[1].replace(/\/\/[^\n]*/g, '');
    for (const item of body.matchAll(/'([^']+)'/g)) entries.push(item[1]);
  }
  return entries;
}

function missingEntries(entries) {
  // 带 * 的是 glob（如 `src/ui/**`），不按文件存在性判断。
  return entries.filter(entry => !entry.includes('*') && !fs.existsSync(path.join(ROOT, entry)));
}

test('eslint.config.mjs 的 ignores 不得指向不存在的文件', () => {
  const entries = eslintIgnoreEntries();
  assert.ok(entries.length > 50, `ignores 条目没解析出来（${entries.length} 条）——检查是否空转`);
  const missing = missingEntries(entries);
  assert.deepEqual(
    missing,
    [],
    `以下 ignores 条目指向的文件已不存在（文件删了就把条目一起删，别留着掩盖同名新文件）：\n${missing.join('\n')}`
  );
});

test('.c8rc.json 的 exclude 不得指向不存在的文件', () => {
  const entries = readJson('.c8rc.json').exclude || [];
  assert.ok(entries.length > 50, `exclude 条目没解析出来（${entries.length} 条）——检查是否空转`);
  const missing = missingEntries(entries);
  assert.deepEqual(
    missing,
    [],
    `以下 exclude 条目指向的文件已不存在：\n${missing.join('\n')}`
  );
});
