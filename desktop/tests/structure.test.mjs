// 桌面结构策略（与 scripts/guard-structure.mjs 同一口径，保证 `npm test` 也能拦住）：
//   · 单文件 ≤ 800 行（基线文件不得留空转余量，阈值 = 实际值）；
//   · desktop/src 根目录文件数 ≤ maxRootFiles。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'architecture-baseline.json'), 'utf8'));
const MAX_FILE_LINES = Number(policy.maxFileLines) || 800;
const MAX_ROOT_FILES = Number(policy.maxRootFiles) || 4;
const BASELINE = policy.fileLineBaseline || {};
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.vite', '.cache']);
const SOURCE_EXT = /\.(?:js|jsx|mjs|cjs)$/;

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const countLines = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
const files = ['src', 'electron', 'tests'].flatMap(name => collect(path.join(DESKTOP, name)));

test('桌面源码单文件不超过 800 行（或与基线逐行相等）', () => {
  const violations = [];
  for (const file of files) {
    const rel = path.relative(DESKTOP, file).split(path.sep).join('/');
    const lines = countLines(fs.readFileSync(file, 'utf8'));
    const limit = BASELINE[rel];
    if (limit === undefined) {
      if (lines > MAX_FILE_LINES) violations.push(`${rel}: ${lines} > ${MAX_FILE_LINES}`);
    } else if (lines !== limit) {
      // 阈值必须等于实际值：大于实际 = 空转余量；小于实际 = 已超基线。
      violations.push(`${rel}: ${lines} != 基线 ${limit}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('desktop/src 根目录文件数不超过上限', () => {
  const rootFiles = fs.readdirSync(path.join(DESKTOP, 'src'))
    .filter(name => /\.(?:js|jsx)$/.test(name));
  assert.ok(
    rootFiles.length <= MAX_ROOT_FILES,
    `desktop/src 根目录 ${rootFiles.length} 个文件 > ${MAX_ROOT_FILES}`
  );
});

test('基线文件与说明存在', () => {
  assert.ok(Array.isArray(policy._baselineChangeLog));
  assert.ok(policy._baselineChangeLog.length > 0);
});
