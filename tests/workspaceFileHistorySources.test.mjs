// J1 文件历史「来源」收敛测试（2026-10-12）。
//
// 为什么单独开一个文件：本用例的落点横跨**展示层**（FileHistorySheet 的来源文案）
// 与**语言包**（zh-CN/en 的 workspace.fileHistory.source.*）；而它原本更自然的家
// （tests/workspaceFileHistory.test.mjs）在同一时间正被另一批次修改（fileHistory.js
// 的 readIndex 三态化 + 该文件的桩改造）。按「同一文件不并发写」的纪律，本批把新增
// 断言放在新文件里，避免与在飞改动互相覆盖。
//
// 缺陷形态（本条收敛的理由）：`push-baseline` 是**死枚举值** —— 全仓没有任何生产代码
// 以 source:'push-baseline' 调用 recordFileHistory。它只让 UI 挂了一条永不成立的分支、
// 语言包挂了一个永不会显示的词条。撤掉它（而不是补写入者）的三条依据：
//  1) retention.js 把二者登记为**不同保留域**（HISTORY_MAX/historyKeep vs
//     ROLLBACK_KEEP/rollbackKeep）—— 合进同一个 index 会让两套保留期打架；
//  2) 本模块定位是「工具级（路径级）」快照、不进分支 UI；push baseline 是「推送级」
//     （含 sha/commit 语义），由 rollbackBaseline.js 承载；
//  3) H3 并非没有落点：GithubPanel.js 推送成功后写的是 writeRollbackSnapshot(...)，
//     落点在 rollback 域，不在 file-history。
//
// ⚠️ 覆盖面（如实）：本文件只钉**本批有权改的**两处。数据层的
// `FILE_HISTORY_SOURCES`（以及 workspaceFileHistory.test.mjs 里那条把
// 'push-baseline' 当合法来源的断言）位于 fileHistory.js —— 该文件在本批运行时
// 正被另一批次修改，按所有权约定本批未改。收敛的未完成部分在交付报告里列明，
// 不在这里写成一条会变红的测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';
import { en } from '../src/i18n/locales/en.js';

const PUSH_BASELINE_KEY = 'workspace.fileHistory.source.pushBaseline';

test('P1 收敛：死来源 push-baseline 不得出现在 UI 分支与语言包里', () => {
  const sheet = fs.readFileSync(path.resolve('src/workspace/FileHistorySheet.js'), 'utf8');
  // 只看**代码行**：注释里允许写明「撤掉了哪个死值」（那是给下一个人的说明），
  // 但可执行的判定里不许再出现它 —— 否则这条测试会连注释一起当成缺陷报。
  const code = sheet
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  assert.equal(code.includes('push-baseline'), false, '代码里不得再有永不成立的分支');

  assert.equal(
    Object.prototype.hasOwnProperty.call(zhCN, PUSH_BASELINE_KEY), false,
    '中文词条已删（没有生产者的词条只会让「来源」这件事看起来比实际更丰富）'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(en, PUSH_BASELINE_KEY), false,
    '英文词条已删'
  );

  // 兜底默认值仍在，且与数据层收敛口径一致（未知来源 = 工具写入）。
  assert.ok(zhCN['workspace.fileHistory.source.tool'], '中文兜底词条在');
  assert.ok(en['workspace.fileHistory.source.tool'], '英文兜底词条在');
});

test('P1 收敛：来源文案走显式映射，不再有「默认即工具」之外的隐含分支', () => {
  const sheet = fs.readFileSync(path.resolve('src/workspace/FileHistorySheet.js'), 'utf8');
  // 映射表存在，且兜底键就是 tool —— 与 normalizeHistoryEntry 的收敛口径同源。
  assert.ok(sheet.includes('HISTORY_SOURCE_KEYS'), '来源 → 词条走显式映射表');
  assert.ok(
    sheet.includes("tool: 'workspace.fileHistory.source.tool'"),
    '兜底默认值与数据层一致（未知来源 = tool）'
  );
  // 词条仍被渲染在列表行里（收敛不能把「来源」这一列整个删掉）。
  assert.ok(sheet.includes('sourceLabel(entry.source)'), '列表行仍展示来源');
});
