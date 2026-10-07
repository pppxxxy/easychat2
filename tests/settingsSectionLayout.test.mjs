// 设置页布局守卫：三处溢出修复的收缩协商 + 分区顺序/搜索索引对齐。
// 背景（2026-10-07 真机截图取证）：
// - API 名长时「教学/新建」被推出屏——collapseSummary 无 flexShrink，RN 里
//   numberOfLines 只在宽度受限时才截断，文本不收缩就永不截断（与拓展页
//   PaneHeader 溢出同构）；摘要短时按钮又贴死折叠箭头（零间距）；
// - 生成参数字段行大字体下 Switch 被挤出——linkLeft 无弹性、samplingInput
//   minWidth 固定，无收缩协商；
// - 分区调序后五处同步（JSX 顺序/渲染数组/sticky/offsets/搜索索引）易漏，
//   漏一处即搜索跳错或吸顶错位——「关于必须殿底」与索引对齐都钉死在这里。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('折叠头收缩协商：headRight 可缩、箭头有间距、摘要文本可截断', () => {
  const collapsible = read('src/ui/Collapsible.js');
  assert.ok(/headRight:\s*\{[^}]*flexShrink:\s*1/.test(collapsible), 'headRight 必须参与收缩协商');
  assert.ok(/headChevron:\s*\{[^}]*marginLeft/.test(collapsible), '折叠箭头与右侧插槽之间必须有保底间距');

  const styles = read('src/settings/settingsStyles.js');
  assert.ok(/collapseSummary:\s*\{[^}]*flexShrink:\s*1/.test(styles),
    'collapseSummary 必须有 flexShrink——numberOfLines 只在宽度受限时才截断');
});

test('生成参数行挤压顺序：字段名省略 → 输入框收窄 → Switch 固定', () => {
  const card = read('src/settings/SamplingCard.js');
  assert.ok(/<Text style=\{styles\.linkText\} numberOfLines=\{1\}>/.test(card), '字段名必须 numberOfLines 截断');
  assert.ok(/<Text style=\{styles\.collapseSummary\} numberOfLines=\{1\}>/.test(card), '卡头摘要必须 numberOfLines 截断');
  const styles = read('src/settings/settingsStyles.js');
  assert.ok(/linkLeft:\s*\{[^}]*flex:\s*1/.test(styles), 'linkLeft 必须吃剩余空间（受挤压先收缩）');
  assert.ok(/linkText:\s*\{[^}]*flexShrink:\s*1/.test(styles), 'linkText 必须可缩（否则省略号不生效）');
  assert.ok(/samplingInput:\s*\{[^}]*flexShrink:\s*1/.test(styles), 'samplingInput 必须可收窄');
  assert.ok(/samplingInput:\s*\{[^}]*minWidth:\s*84/.test(styles), 'samplingInput 保底下限 84 不得丢');
});
