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
import { localeSource } from './helpers/localeSource.mjs';

import { SETTINGS_SEARCH_INDEX, settingsSectionLabel } from '../src/settings/searchIndex.js';
import { translate } from '../src/i18n/index.js';

const read = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('折叠头收缩协商：headRight 可缩、箭头有间距、摘要文本可截断', () => {
  const collapsible = read('src/ui/Collapsible.js');
  assert.ok(/headRight:\s*\{[^}]*flexShrink:\s*1/.test(collapsible), 'headRight 必须参与收缩协商');
  assert.ok(/headChevron:\s*\{[^}]*marginLeft/.test(collapsible), '折叠箭头与右侧插槽之间必须有保底间距');
  assert.ok(collapsible.includes('style={styles.headChevron}'), '折叠箭头必须实际接线间距样式（定义而不用=假修复）');

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

test('分区顺序：关于殿底、语言倒数第二，渲染顺序与搜索索引对齐', () => {
  const screen = read('src/SettingsScreen.js');
  // 顺序定义的唯一事实源已搬到 settings/sectionOrder.js（纯数据）——searchIndex.js 也要用它，
  // 而 SettingsScreen.js 反过来 import searchIndex.js，留在原处就成环了。
  // 这里从**新家**取那份数组字面量；SettingsScreen.js 只做 re-export。
  const orderSource = read('src/settings/sectionOrder.js');
  const match = /const SECTION_RENDER_ORDER = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(orderSource);
  assert.ok(match, 'SECTION_RENDER_ORDER 必须是 sectionOrder.js 里的模块级数组字面量（唯一事实源）');
  const order = match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.equal(order[order.length - 1], 'about', '关于必须是最后一张卡（用户硬诉求）');
  assert.equal(order[order.length - 2], 'language', '语言在关于之前');
  assert.ok(order.includes('localmodel'), '本地模型必须是独立卡');
  assert.ok(order.indexOf('localmodel') > order.indexOf('github'), '本地模型卡在 GitHub 之后');
  assert.equal(new Set(order).size, order.length, '分区 id 不得重复');

  // 五处同步之搜索索引：sectionId 必须都在渲染顺序内，否则搜索跳错/吸顶错位
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.ok(order.includes(entry.sectionId),
      `搜索条目「${entry.labelKey}」的 sectionId=${entry.sectionId} 必须在 SECTION_RENDER_ORDER 内`);
  }
  // 分区名走 i18n（labelKey），测试传 zh-CN 的 t 看译名。
  const t = key => translate('zh-CN', key);
  assert.equal(settingsSectionLabel('localmodel', t), '本地模型', '搜索结果的分区名必须登记');
  assert.ok(settingsSectionLabel('about', t), '关于的分区名保留');

// 五处同步之 offsets：收口后偏移登记只有 registerSection 一条路径，且 JSX 里各卡的
  // 登记顺序必须与 SECTION_RENDER_ORDER 逐条一致。此前各处各手写
  // `sectionOffsetsRef.current.<id> = ...`：sampling 就是这么漏掉的（搜索命中它时只闪烁、
  // 不滚动），而漏掉不会有任何报错——这条断言把它钉死。
  const registered = [...screen.matchAll(/onLayout=\{registerSection\('(\w+)'\)\}/g)].map(m => m[1]);
  assert.deepEqual(registered, order, 'JSX 里各卡的偏移登记顺序必须与 SECTION_RENDER_ORDER 完全一致');
  assert.equal((screen.match(/sectionOffsetsRef\.current\.\w+ = event/g) || []).length, 0,
    '禁止再手写 sectionOffsetsRef.current.<id> = ...（偏移登记只走 registerSection）');
  // 吸顶索引由渲染顺序数组推导（自动跟随，禁止另写一份）。允许包在平台门控里
  //（Android 必须走空数组，见文件末尾的 #25157 守卫），但推导源只能是同一份数组。
  assert.ok(
    /stickyHeaderIndices[\s\S]{0,400}?SECTION_RENDER_ORDER\n?\s*\.map\(/.test(screen),
    '吸顶索引必须由 SECTION_RENDER_ORDER 推导',
  );

  // 单一事实源必须导出，且 SettingsScreen.js 只 re-export（别又抄一份到本文件里）
  assert.ok(/export const SECTION_RENDER_ORDER = Object\.freeze\(\[/.test(orderSource),
    'SECTION_RENDER_ORDER 必须在 sectionOrder.js 里导出');
  assert.ok(/export\s*\{\s*SECTION_RENDER_ORDER\s*\}/.test(screen),
    'SettingsScreen.js 必须 re-export SECTION_RENDER_ORDER（保持既有 import 方兼容）');
  assert.ok(
    /import\s*\{[^}]*SECTION_RENDER_ORDER[^}]*\}\s*from\s*'\.\/settings\/sectionOrder\.js'/.test(screen),
    'SettingsScreen.js 必须从 settings/sectionOrder.js import（不许自带一份字面量）',
  );

  // 旧挂载点清理：关于卡不再含本地模型入口；新卡直连面板
  const about = read('src/settings/sections/AboutSection.js');
  assert.ok(!about.includes('localModel') && !about.includes('localmodel'), 'AboutSection 不得再含本地模型入口');
  assert.ok(screen.includes("t('settings.localModel.title')"), '本地模型独立卡使用新文案键');
  assert.ok(screen.includes('onPress={() => setLocalModelOpen(true)}'), '本地模型卡直连面板');
  // 文案键迁移：旧键退役
  const locales = ['src/i18n/locales/zh-CN', 'src/i18n/locales/en'];
  for (const file of locales) {
    const table = localeSource(file);
    assert.ok(!table.includes("'settings.about.localModel'"), `${file} 旧键 settings.about.localModel 必须删除`);
    assert.ok(table.includes("'settings.localModel.title'") && table.includes("'settings.localModel.entry'"),
      `${file} 必须有 settings.localModel.title/entry`);
  }
});

test('API 折叠头不再显示配置方名（2026-10-07 裁决），仅保留未配置提示', () => {
  const screen = read('src/SettingsScreen.js');
  assert.ok(!screen.includes('apiSummary'), 'apiSummary 计算与渲染必须整体移除');
  assert.ok(screen.includes("t('settings.summary.unconfigured')"), '未配置状态保留小字提示');
  const apiHead = screen.slice(screen.indexOf("flashSection === 'api'"), screen.indexOf('<SamplingCard'));
  assert.ok(apiHead.includes('TopicButton') && apiHead.includes("t('settings.api.add')"), '教学与新建按钮保留');
  const summaryText = /<Text style=\{styles\.collapseSummary\}[^>]*>\{([^}]*)\}<\/Text>/.exec(apiHead);
  assert.ok(summaryText && summaryText[1].includes('settings.summary.unconfigured'),
    'API 头唯一的摘要文本只允许「未配置」提示（配置名/模型名不得回流）');
});

// 吸顶索引的平台门控（2026-10-12，用户报告「切到设置界面即闪退」）。
// 根因：Android 上 ScrollView 只要 stickyHeaderIndices 非空就会走吸附路径——RN 会
// React.Children.toArray 重排子节点 key、并强制关闭 removeClippedSubviews；在**同一次渲染
// 里既换子节点又换该数组**时原生层闪退（facebook/react-native#25157）。记忆页 2026-10-06
// 已按此修过（943dbde1），设置页是当时唯一剩下的漏网处：进入时 api/persona 先按「未配置」
// 默认展开，随后几个 async 加载把它们收起（language 恒展开），必然同时改动两者。
test('吸顶索引只在 iOS 启用：全仓每处派生都按平台门控，且 Android 分支用稳定引用', () => {
  // 每条「派生 stickyHeaderIndices 的文件」都必须门控。用全仓扫描而不是写死文件名：
  // 记忆页的派生值已经随「列表视图模型外提」搬进 memory/useMemoryListView.js，
  // 写死路径的守卫会在文件搬家时变成空转（本仓 MEMORY.md 记过这类教训）。
  // 扫描面只认**派生点**（`const stickyHeaderIndices = ...`），不认消费处的
  // `stickyHeaderIndices={...}`——否则「用它的地方」也会被当成规则对象，而门控在别处。
  const DERIVE = /(?:const|let|var)\s+stickyHeaderIndices\s*=/;
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
  const deriving = walk('src')
    .filter(file => file.endsWith('.js') && DERIVE.test(fs.readFileSync(file, 'utf8')))
    .map(file => file.split(path.sep).join('/'));
  assert.ok(deriving.length > 0, '应至少有一处派生 stickyHeaderIndices（否则本守卫在空转）');

  for (const file of deriving) {
    const source = read(file);
    const at = source.search(DERIVE);
    const block = source.slice(at, at + 800);
    assert.ok(
      /Platform\.OS\s*===\s*'ios'|Platform\.OS\s*!==\s*'ios'/.test(block),
      `${file}：stickyHeaderIndices 必须按平台门控（Android 走空数组），否则重蹈 #25157 原生闪退`,
    );
  }

  const settings = read('src/SettingsScreen.js');
  // 定义而不用 = 假修复：消费处必须真的接上这个派生值。
  assert.ok(settings.includes('stickyHeaderIndices={stickyHeaderIndices}'), '设置页吸顶必须实际接线');
  // Android 分支的返回值必须是**同一个**冻结数组：每渲染新建的 [] 会让该 prop 每帧都变。
  assert.ok(
    /const NO_STICKY_HEADERS = Object\.freeze\(\[\]\)/.test(settings),
    '设置页需要一个模块级冻结的空数组常量（稳定引用）',
  );
  assert.ok(/Platform\.OS !== 'ios'\) return NO_STICKY_HEADERS/.test(settings),
    'Android 分支必须返回该常量而不是新建的字面量数组',
  );
});
