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
  // ⚠️ 50 → 40（2026-10-12）：这不是放宽检查，而是**空转哨兵**随清单实际规模重标。
  // 哨兵的职责只有一个——上面那个正则哪天解析不出东西了，这里要报警，而不是让「死条目」
  // 检查静默通过（deepEqual([], []) 恒真）。同一天一次性删掉 79 条**实测零命中**的过时行
  //（见 eslint.config.mjs 两段清单的注释），解析出的条目数从 117 落到 45 ⇒ 旧的 50 会把
  // 「清单变短」误报成「正则空转」。判据仍是「远大于 0 且低于当前实际值」，语义未变。
  assert.ok(entries.length > 40, `ignores 条目没解析出来（${entries.length} 条）——检查是否空转`);
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
