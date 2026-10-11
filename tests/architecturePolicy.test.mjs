// 架构策略（Z 系采纳 #2）：行数棘轮基线的不变量。
// 与 scripts/guard-structure.mjs 同口径（行数按 wc -l 语义），这里把不变量也钉进测试套件。
// 注意两条棘轮不是一回事：根目录文件数上限是**硬闸**（历史 36→31，只降不升）；
// 文件行数基线是**预算 + 摩擦**——允许在提交说明写清理由、且代码与结构仍满足长期可维护
// 的前提下抬高（2026-10-12 用户裁决；此前文案写「只许减不许增」而实际抬高过 113 次）。
// 守卫脚本自身的**行为**由 tests/guardStructure.test.mjs 负责（真跑脚本 + 违规样本），
// 本文件不再断言脚本里的提示文案与函数名——那种断言在规则空转时照样全绿。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const baseline = JSON.parse(readFileSync(path.join(ROOT, 'architecture-baseline.json'), 'utf8'));

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

// 回归 2026-10-11 审查 P2：基线里存在**远高于实际行数**的空转余量
// （ChatPanel.js 1851 vs 实际 1712、WorkspaceSettingsSheet.js 904 vs 818、
//  FilesPanel.js 1580 vs 1534），棘轮对这几个文件形同虚设——可以悄悄长回一百多行才报警。
// 这条把「阈值 = 当前实际值，不再留缓冲」这条写在 guard-structure.mjs 文件头的协议
// 变成可执行的不变量：基线高于实际就是余量，余量必须为 0。
// 代价是有意为之：文件变短时要顺手把基线数字一起下调（一个数字，同一次提交）。
//
// 2026-10-12 用户裁决后口径更清楚：**允许抬高**，但抬高必须「提交说明写清理由 +
// 代码与结构仍满足长期可维护」，且与代码改动同一次提交（guard 的失败文案会这么提示，
// 行为由 tests/guardStructure.test.mjs 真跑脚本钉住）。抬高到新的实际值正是本条允许的形态——
// 本条拦的始终是「留余量」，不是「改数字」。
test('回归 P2：行数基线不留空转余量（阈值 = 当前实际值）', () => {
  const air = [];
  for (const [r, limit] of Object.entries(baseline.fileLineBaseline)) {
    const file = path.join(ROOT, r);
    if (!existsSync(file)) continue;
    const lines = countLines(readFileSync(file, 'utf8'));
    if (limit > lines) air.push(`${r}: 基线 ${limit} > 实际 ${lines}（空转 ${limit - lines} 行）`);
  }
  assert.deepEqual(air, [],
    `以下基线高于实际行数，棘轮因此失去意义——请把基线下调到实际值：\n${air.join('\n')}`);
});

// 这里原有 5 条**纯文案断言**（守卫脚本里必须出现 '超出各自基线行数' / '超过行数上限' /
// '检出模块循环依赖' / 'function stripComments' 等字符串）。它们钉的是提示文案与函数名，
// 不是行为：守卫把判据写错、规则彻底空转时，这些字符串**原样还在**，测试照样全绿
//（2026-10-11 审查里「面板禁止自套 Modal」空转就是这么活下来的）。
// 真正能发现「规则空转」的是行为测试：见 tests/guardStructure.test.mjs——把守卫脚本复制进
// 临时仓库根、喂一个违规样本、断言它以非零码失败。文案断言已删除，不再重复占位。
