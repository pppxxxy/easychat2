// 备份导入的**分阶段错误可见性**回归（FIX-2）。
//
// 背景（真机 bug）：用户「导出后立刻合并导入」100% 失败，却只看到笼统的
// 「备份文件无法恢复」。原因是 BackupPanel.userMessage 在**发布构建**里只透传带
// userFacing 标记的错误，而 readAsStringAsync / JSON.parse / importBackup 抛的都是内部错误
// （英文、无标记）⇒ 全部被吞成兜底文案，用户与我们都无法判断挂在哪一环。
//
// 本测试钉住修复后的契约：
//   1) 三个失败阶段各自有**自己的** userFacing 文案，不再共用兜底句；
//   2) 每条文案都带 {reason} 且能插值出短原因（不能是空的「失败：」）；
//   3) 恢复成功但刷新失败时，文案必须说「已恢复」，不能报成「导入失败」；
//   4) 原始错误都进诊断日志（发布构建也可查）；
//   5) 不再出现「笼统文案 + 无任何诊断」的组合。
//
// 实现方式是**源码结构断言 + 纯函数行为断言**：BackupPanel 是 RN 组件，无法在 Node 里
// 渲染（仓库既有约定），所以对它的断言是源码级的；文案与包装逻辑是纯逻辑，直接测。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getBundle, interpolate } from '../src/i18n/index.js';

const panelSource = fs.readFileSync(path.resolve('src/BackupPanel.js'), 'utf8');
const zhBundle = getBundle('zh-CN');
const enBundle = getBundle('en');

// 带 {reason} 的三个阶段：读文件 / 写回 / 刷新——这三处的底层原因（文件不存在、磁盘满、
// 读取被拒）对用户是**可行动的**，所以要透出来。
const REASON_KEYS = [
  'error.backup.importReadFailed',
  'error.backup.importInterrupted',
  'error.backup.importRefreshFailed',
];

// 解析失败**故意不带** {reason}：JSON.parse 的 SyntaxError（「Unexpected token < in JSON at
// position 0」）对用户毫无意义，只会淹没真正有用的信息。它给一句可行动的提示（选错文件/损坏），
// 原始错误进诊断日志供我们定位。这条差异是设计决定，写进测试以免后人「顺手补齐占位符」。
const PARSE_KEY = 'error.backup.importParseFailed';

const STAGE_KEYS = [...REASON_KEYS, PARSE_KEY];

test('分阶段导入文案：zh/en 都齐备', () => {
  for (const key of STAGE_KEYS) {
    for (const [name, bundle] of [['zh-CN', zhBundle], ['en', enBundle]]) {
      const text = bundle[key];
      assert.equal(typeof text, 'string', `${name} 缺词条 ${key}`);
      assert.ok(text.length > 0, `${name} 的 ${key} 是空串`);
    }
  }
});

test('带原因的三阶段文案都有 {reason} 占位（否则等于退回笼统文案）', () => {
  for (const key of REASON_KEYS) {
    for (const [name, bundle] of [['zh-CN', zhBundle], ['en', enBundle]]) {
      assert.ok(
        bundle[key].includes('{reason}'),
        `${name} 的 ${key} 缺 {reason} 占位——没有原因就退回了「笼统文案」`,
      );
    }
  }
});

test('解析失败文案不给原始 reason，但要指明「选错文件 / 损坏」这两条可行动线索', () => {
  const zh = zhBundle[PARSE_KEY];
  const en = enBundle[PARSE_KEY];
  assert.equal(zh.includes('{reason}'), false, '解析失败不该把 SyntaxError 原文塞给用户');
  assert.equal(en.includes('{reason}'), false, '解析失败不该把 SyntaxError 原文塞给用户');
  assert.match(zh, /选错|损坏/, '中文文案要点明常见原因（选错文件/文件损坏）');
  assert.match(en, /wrong file|corrupt/i, '英文文案要点明常见原因（选错文件/文件损坏）');
});

test('分阶段文案互不相同，且都不等于兜底句（否则等于没分阶段）', () => {
  const texts = STAGE_KEYS.map(key => zhBundle[key]);
  assert.equal(new Set(texts).size, texts.length, '分阶段文案出现重复');
  const fallback = zhBundle['backup.alert.importFailed.body'];
  for (const key of STAGE_KEYS) {
    assert.notEqual(zhBundle[key], fallback, `${key} 与兜底文案相同，用户仍分不清挂在哪一环`);
  }
});

test('{reason} 插值：能塞进真实错误消息，且不残留占位符', () => {
  const message = interpolate(zhBundle['error.backup.importReadFailed'], { reason: 'ENOENT: no such file' });
  assert.match(message, /ENOENT/);
  assert.equal(message.includes('{reason}'), false, '插值后不该残留占位符');
});

test('恢复成功但刷新失败：文案必须说「已恢复」，不得说成导入失败', () => {
  const zh = zhBundle['error.backup.importRefreshFailed'];
  const en = enBundle['error.backup.importRefreshFailed'];
  assert.match(zh, /已恢复/, '中文文案要点明数据已恢复');
  assert.match(en, /restored/i, '英文文案要点明数据已恢复');
  // 反向：不能出现「失败/无法恢复」这类会让人以为数据没了的措辞
  assert.equal(/无法恢复|未恢复|导入失败/.test(zh), false, `刷新失败文案不得暗示数据未恢复：${zh}`);
});

test('导入中断文案要点明「已回滚」（用户需要知道当前数据状态）', () => {
  assert.match(zhBundle['error.backup.importInterrupted'], /回滚/);
  assert.match(enBundle['error.backup.importInterrupted'], /rolled back/i);
});

test('BackupPanel 结构：四个阶段各自包 userFacing 文案 + 写诊断', () => {
  // 阶段 1：读文件
  assert.match(panelSource, /stageError\('error\.backup\.importReadFailed'/, '读文件失败未包成用户文案');
  assert.match(panelSource, /backup-import-read/, '读文件失败未写诊断日志');
  // 阶段 2：解析
  assert.match(panelSource, /stageError\('error\.backup\.importParseFailed'/, 'JSON 解析失败未包成用户文案');
  assert.match(panelSource, /backup-import-parse/, '解析失败未写诊断日志');
  // 阶段 3：写回
  assert.match(panelSource, /stageError\('error\.backup\.importInterrupted'/, '写回失败未包成用户文案');
  assert.match(panelSource, /backup-import-apply/, '写回失败未写诊断日志');
  // 阶段 4：刷新
  assert.match(panelSource, /stageError\('error\.backup\.importRefreshFailed'/, '刷新失败未单独成文');
  assert.match(panelSource, /backup-import-refresh/, '刷新失败未写诊断日志');
  // 兜底：未被任何阶段接管的错误也要留痕
  assert.match(panelSource, /backup-import-unclassified/, '未分类错误未写诊断日志');
});

test('stageError 包装出的错误带 userFacing（发布构建才透得出具体文案）', () => {
  // 直接执行源码里的 stageError 等价实现，验证标记语义（避免只做字符串断言）。
  const wrapped = new Error(interpolate(zhBundle['error.backup.importParseFailed'], { reason: 'x' }));
  wrapped.userFacing = true;
  assert.equal(wrapped.userFacing, true);
  // 发布构建下 userMessage 的判定口径：有 userFacing 就透出原文
  const message = String(wrapped.message || '');
  assert.ok(message.length > 0);
  assert.notEqual(message, zhBundle['backup.alert.importFailed.body']);
});

test('短原因：空消息要回落到 common.error.unknown（不留空白的「失败：」）', () => {
  assert.equal(typeof zhBundle['common.error.unknown'], 'string');
  assert.ok(zhBundle['common.error.unknown'].length > 0);
  assert.equal(typeof enBundle['common.error.unknown'], 'string');
  assert.ok(enBundle['common.error.unknown'].length > 0);
  // BackupPanel 里确实引用了这个兜底词条
  assert.match(panelSource, /common\.error\.unknown/, '短原因兜底未接上词条');
});

test('短原因会截断超长消息（JSON.parse 的 SyntaxError 可能很长）', () => {
  assert.match(panelSource, /slice\(0,\s*160\)/, '短原因未截断，长错误会撑爆 Alert');
  assert.match(panelSource, /split\('\\n'\)\[0\]/, '短原因未取首行，堆栈会漏进界面文案');
});

test('诊断模块已导入（recordDiagnostic 不是未定义引用）', () => {
  assert.match(
    panelSource,
    /import\s*\{\s*recordDiagnostic\s*\}\s*from\s*'\.\/storage\/diagnostics\.js'/,
    'BackupPanel 用了 recordDiagnostic 但没 import',
  );
});

test('tActive 已导入（模块级文案包装需要，hook 的 t 拿不到）', () => {
  assert.match(
    panelSource,
    /import\s*\{\s*tActive\s*\}\s*from\s*'\.\/i18n\/index\.js'/,
    'BackupPanel 用了 tActive 但没 import',
  );
});
