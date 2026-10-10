// 架构策略（Z 系采纳 #2）：行数棘轮基线的不变量 + 守卫接线。
// 与 scripts/guard-structure.mjs 同口径（行数按 wc -l 语义），这里把不变量也钉进测试套件。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const baseline = JSON.parse(readFileSync(path.join(ROOT, 'architecture-baseline.json'), 'utf8'));
const guardSource = readFileSync(path.join(ROOT, 'scripts', 'guard-structure.mjs'), 'utf8');

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const countLines = src => src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');

test('基线文件结构完整', () => {
  assert.equal(baseline.version, 1);
  assert.equal(typeof baseline.maxFileLines, 'number');
  assert.ok(baseline.maxFileLines > 0);
  assert.ok(Array.isArray(baseline.excludedPaths));
  assert.equal(typeof baseline.fileLineBaseline, 'object');
  assert.ok(Array.isArray(baseline.allowedCycles));
});

test('棘轮不变量：基线内文件不超过各自基线，基线外文件不超过上限', () => {
  const files = collectJsFiles(path.join(ROOT, 'src')).concat([path.join(ROOT, 'App.js')]);
  const violations = [];
  for (const file of files) {
    const r = rel(file);
    if (baseline.excludedPaths.some(prefix => r.startsWith(prefix))) continue;
    const lines = countLines(readFileSync(file, 'utf8'));
    const limit = baseline.fileLineBaseline[r];
    if (limit !== undefined) {
      if (lines > limit) violations.push(`${r}: ${lines} > baseline ${limit}`);
    } else if (lines > baseline.maxFileLines) {
      violations.push(`${r}: ${lines} > limit ${baseline.maxFileLines}`);
    }
  }
  assert.deepEqual(violations, [], `行数棘轮被突破：\n${violations.join('\n')}`);
});

test('守卫脚本已接线两项新规则', () => {
  assert.ok(guardSource.includes('architecture-baseline.json'), '读基线');
  assert.ok(guardSource.includes('超出各自基线行数'), '行数棘轮规则');
  assert.ok(guardSource.includes('超过行数上限'), '新文件超限规则');
  assert.ok(guardSource.includes('检出模块循环依赖'), '循环依赖规则');
  assert.ok(guardSource.includes('function stripComments'), '扫描前剥离注释（防注释里的 import 误判）');
});
