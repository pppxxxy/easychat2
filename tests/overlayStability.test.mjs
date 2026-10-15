// FEAT-AC5：稳定性三修 + 日志整治。
//
// 三个 bug 的定性（本轮任务书 §一，全部已对码核实）：
//   ① 工作区看屏幕对话点不开 → ScreenWatchPanel 线程行是裸 View（UI 缺失）
//   ② 悬浮窗已关仍显示「关闭悬浮窗」 → JS 只在挂载时查一次（缺回前台对账）
//   ③ 诊断日志满屏 Error: → 例行打点被包成 new Error() 换堆栈（日志分级缺失）
//   ④ diary run 刷屏 → written=0 的纯跳过也记一条（无意义成功也记）
//
// 测试分工（仓库纪律：纯逻辑才设 Node 测试，UI 渲染结构不测）：
//   · 纯层 reconcileOverlayState / formatThreadEntryTime —— 真跑
//   · 接线层（谁调用了谁）—— 源码断言，且**断言调用点而非名字**（见各条注释）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeActualOverlayState, reconcileOverlayState } from '../src/screenWatch/overlayStateSync.js';
import { formatThreadEntryTime, threadEntryRoleKey } from '../src/screenWatch/threadEntries.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// 剥注释：本仓反复踩到的假阳性形态——注释里正解释着被禁的旧写法，
// 按整文件匹配会自己打自己（overlayConfirm.test.mjs:251 同款做法）。
function stripComments(source) {
  return source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ---------- ① 纯层：对账判定 ----------

test('对账：真实态与本地态不一致 → 刷新 + 留痕', () => {
  // 核心场景（任务书 §五 第 2 条）：用户从悬浮窗自己的「关闭」关掉，
  // app 在后台没收到事件，本地仍以为开着。
  const off = reconcileOverlayState({ localActive: true, actual: false });
  assert.equal(off.changed, true);
  assert.equal(off.active, false);
  assert.match(off.message, /actual=off/, '留痕要写明对账结果');
  assert.match(off.message, /local=on/, '留痕要写明原值（否则事后无法判断是谁错了）');

  const on = reconcileOverlayState({ localActive: false, actual: true });
  assert.equal(on.changed, true);
  assert.equal(on.active, true);
});

test('对账：一致 → 不刷新、**不留痕**（每次回前台都记 = 把日志重新灌成噪音）', () => {
  for (const value of [true, false]) {
    const result = reconcileOverlayState({ localActive: value, actual: value });
    assert.equal(result.changed, false, '一致不该触发刷新');
    assert.equal(result.active, value, '状态保持');
    assert.equal(result.message, '', '一致时必须无留痕——P0-C 治的就是这类例行噪音');
  }
});

test('对账：读不到真实态（null/undefined/垃圾值）→ 维持现状，不谎报未开启', () => {
  // 这是本判定最容易做错的一处：把「查失败」当成「未开启」，界面会主动把
  // **真实开着**的悬浮窗画成关闭，用户点一下反而撞上「已在运行」。
  // 与本仓「读不出来 ≠ 没有」同型（threads.js 三态）。
  for (const actual of [null, undefined, 'yes', 0, 1, {}]) {
    const result = reconcileOverlayState({ localActive: true, actual });
    assert.equal(result.changed, false, `actual=${JSON.stringify(actual)} 不该触发刷新`);
    assert.equal(result.active, true, '读不到时维持本地态');
    assert.equal(result.message, '');
  }
  // 反向同理：本地关着、读不到 → 保持关着（不猜成开着）
  assert.equal(reconcileOverlayState({ localActive: false, actual: null }).active, false);
});

test('对账：入参缺失不抛（调用方从原生载荷取值，拿到 undefined 是常态）', () => {
  const result = reconcileOverlayState();
  assert.equal(result.changed, false);
  assert.equal(result.active, false);
  assert.equal(reconcileOverlayState(null).changed, false);
});

test('三态归一：只有布尔真值才算「读到了」', () => {
  assert.equal(normalizeActualOverlayState(true), true);
  assert.equal(normalizeActualOverlayState(false), false);
  for (const raw of [null, undefined, 0, 1, '', 'true', {}, []]) {
    assert.equal(normalizeActualOverlayState(raw), null, `${JSON.stringify(raw)} 应归为读不到`);
  }
});

// ---------- ② 纯层：条目时间与角色标签 ----------

test('条目时间：MM-DD HH:mm（补零），缺失/非法 → 空串（不显示 1970）', () => {
  const at = new Date(2026, 9, 15, 8, 5).getTime();   // 2026-10-15 08:05 本地时间
  assert.equal(formatThreadEntryTime(at), '10-15 08:05');
  for (const bad of [0, null, undefined, '', 'abc', NaN]) {
    assert.equal(formatThreadEntryTime(bad), '', `${JSON.stringify(bad)} 应返回空串`);
  }
});

test('条目角色标签：工作区线程里叫「工作区助手」，不叫「角色」', () => {
  // 复用记忆页的 memory.provenance.evidence.roleAssistant（=「角色」）在这个语境里指错人：
  // 工作区线程里说话的是工作区助手。两个键都必须存在且互不相同。
  assert.equal(threadEntryRoleKey('user'), 'workspace.watch.roleUser');
  assert.equal(threadEntryRoleKey('assistant'), 'workspace.watch.roleAssistant');
  // 未知 role 归 assistant（与 threads.js 的 normalizeThreadEntry 同口径：非 user 即 assistant）
  assert.equal(threadEntryRoleKey('system'), 'workspace.watch.roleAssistant');
  assert.equal(threadEntryRoleKey(undefined), 'workspace.watch.roleAssistant');
});

// ---------- ③ 接线：P0-A 线程行可点开 ----------

test('P0-A：线程行是 TouchableOpacity 且真的绑了 onPress（不是裸 View）', () => {
  const panel = read('src/workspace/screen/ScreenWatchPanel.js');
  // 回归：旧实现是 `<View key={thread.id} style={styles.threadRow}>`——看着像卡片但点不动。
  // ⚠️ 断言**结构**而非「出现过 onPress 字样」：本文件另有 modeChip / 发送按钮带 onPress，
  // 只查 includes('onPress') 会被它们满足（同型假阳性本仓踩过多次）。
  assert.equal(/<View key=\{thread\.id\} style=\{styles\.threadRow\}>/.test(panel), false,
    '线程行不得再是裸 View（旧实现点不动）');
  assert.match(panel, /<TouchableOpacity\s+style=\{styles\.threadRow\}\s+onPress=\{\(\) => toggleThread\(thread\.id\)\}/,
    '线程行必须是可点开的 TouchableOpacity');
  // 展开态由 expandedId 驱动，且展开后渲染每条 entry 的正文
  assert.ok(panel.includes('expandedId'), '有展开态');
  assert.match(panel, /const expanded = expandedId === thread\.id;/, '按 id 判定展开');
  assert.match(panel, /entries\.map\(entry => \(/, '展开态逐条渲染 entry');
  // 全文可选中（任务书 §二 第 2 条：用户要能复制出错信息去搜）
  assert.match(panel, /<Text style=\{styles\.entryText\} selectable>\{entry\.text\}<\/Text>/,
    '条目正文必须 selectable');
  // 展开态要有时间与角色名（用刚测过的两个纯函数）
  assert.ok(panel.includes('threadEntryRoleKey(entry.role)'), '显示角色名');
  assert.ok(panel.includes('formatThreadEntryTime(entry.at)'), '显示时间');
});

test('P0-A：删除走二次确认，且失败必须说出来（不静默）', () => {
  const panel = read('src/workspace/screen/ScreenWatchPanel.js');
  const code = stripComments(panel);
  // 删除必须复用 threads.js 既有函数，不许另写一份存储逻辑
  assert.match(code, /deleteScreenWatchThread\(item\.id\)/, '复用既有删除函数');
  // 破坏性操作必须 Alert 二次确认（app 面板内允许全屏框，与悬浮窗的限制无关）
  assert.match(panel, /Alert\.alert\(\s*t\('workspace\.watch\.deleteThread\.title'\)/, '删除前二次确认');
  // ⚠️ 断言失败分支体内**真的有提示**：只查 includes('deleteFailed') 时，
  // 留一个 i18n 键名在别处就能蒙混。这里钉住 catch 块里调用了 setNote。
  assert.match(panel, /\.catch\(error => \{[\s\S]{0,200}?setNote\(\(error && error\.message\) \|\| t\('common\.error\.deleteFailed'\)\)/,
    '删除失败必须提示（静默失败 = 用户以为删掉了）');
  // 删掉展开中的那场要收起，否则展开态指向一个不存在的 id
  assert.match(panel, /setExpandedId\(current => \(current === item\.id \? '' : current\)\)/,
    '删除后收起展开态');
});

// ---------- ④ 接线：P0-B 回前台对账 ----------

test('P0-B：两处状态行共用同一个 hook，且 hook 内有 AppState 回前台对账', () => {
  const hook = read('src/screenWatch/useOverlayActive.js');
  // 回前台必然重查一次（核心）：必须断言**监听器体内**真的调了 reconcile，
  // 不能只查 includes('AppState')——那样把监听体清空也照样绿。
  assert.match(hook, /AppState\.addEventListener\('change', next => \{[\s\S]{0,300}?if \(cameToForeground\) reconcile\(\)/,
    '回前台必须真的触发对账');
  assert.match(hook, /const cameToForeground = previous !== 'active' && next === 'active';/,
    '只在「非前台 → 前台」时对账（切后台不对账）');
  // 挂载查询保留（既有行为回归）
  assert.match(hook, /normalizeActualOverlayState\(await readOverlayActive\(\)\)/, '挂载时查一次');
  // 事件推送保留（事件是即时的，对账只是兜底——任务书 §三 的原则）
  assert.match(hook, /addStateListener\(\(\{ active: next \}\)/, '事件推送保留');
  // 对账留痕必须是无堆栈的纯文本（配合 P0-C）
  assert.match(hook, /recordDiagnostic\('storage', \{ message: result\.message \}/,
    '对账留痕走 { message }（无堆栈）');

  // 两处状态行都必须改用 hook —— 此前各自只在挂载时查一次（同一个病写两遍）
  for (const file of ['src/screenWatch/ScreenWatchScreen.js', 'src/workspace/screen/ScreenWatchPanel.js']) {
    const source = read(file);
    assert.ok(source.includes('useOverlayActive'), `${file} 应改用共用 hook`);
    assert.equal(/\bisOverlayActive\b/.test(stripComments(source)), false,
      `${file} 不该再自己调 isOverlayActive（hook 已收口）`);
  }
});

test('P0-B：ScreenWatchScreen 不再重复订阅状态事件（两个监听器写同一份状态）', () => {
  const screen = read('src/screenWatch/ScreenWatchScreen.js');
  const code = stripComments(screen);
  // hook 内已挂 addStateListener；屏幕再挂一个会让「谁才是权威」变模糊。
  assert.equal(/addStateListener\(/.test(code), false, '不得重复订阅状态事件');
  assert.equal(/addStateListener,/.test(code), false, '也不该再 import 它');
});

test('P0-B：三态读取走 readOverlayActive（isOverlayActive 把异常吞成 false，不能用于对账）', () => {
  const overlay = read('src/screenWatch/overlay.js');
  // readOverlayActive 必须存在且返回三态
  assert.match(overlay, /export async function readOverlayActive\(\)/);
  assert.match(overlay, /return value === true \? true : \(value === false \? false : null\);/,
    '三态归一：非布尔 → null');
  // 老构建（没有该方法）→ null 而非 false
  assert.match(overlay, /typeof module\.isOverlayActive !== 'function'\) return null/,
    '方法缺失时返回 null（读不到），不是 false（没开）');
});

// ---------- ⑤ 接线：P0-C 日志分级 ----------

test('P0-C：例行打点不再包 new Error（满屏 Error: 的根因）', () => {
  const overlay = read('src/screenWatch/overlay.js');
  // 采集链路打点：必须传 { message } 对象
  assert.match(overlay, /recordDiagnostic\('storage', \{ message: `\[screen-overlay\] \$\{parsed\.stage\}` \}, parsed\.detail\)/,
    '例行打点改传 { message }（无堆栈）');
  assert.equal(/recordDiagnostic\('storage', new Error\(`\[screen-overlay\]/.test(overlay), false,
    '不得再用 new Error 换堆栈');

  const bridge = read('src/screenWatch/overlayConfirmBridge.js');
  // 确认结果留痕：允许/拒绝/超时是**例行事件**，不是错误
  assert.match(bridge, /recordDiagnostic\(\s*'log',\s*\{ message: `\[overlay-confirm\] \$\{reason\}` \}/,
    '确认留痕改传 { message }');
  assert.equal(/recordDiagnostic\('log', new Error\('\[overlay-confirm\]/.test(bridge), false,
    '不得再用 new Error');

  // 反例守护：**真错误**必须仍带堆栈（把日志分级做过头 = 真错误也没法排查）
  const diagnostics = read('src/screenWatch/screenWatchDiagnostics.js');
  assert.match(diagnostics, /new Error\(`\[screen-watch\] vision-test \$\{stage\} failed/,
    '采集失败是真错误，必须保留堆栈');
});

test('P0-C：diary run 纯跳过（written=0 且 failed=0）不记日志，真写入/真失败才记', () => {
  const runner = read('src/diary/runDiary.js');
  // ⚠️ 断言判据本体：必须是 written/failed 的正向判定，
  // 只查 includes('recordDiagnostic') 会被任何一处调用满足。
  assert.match(runner, /if \(outcome\.written > 0 \|\| outcome\.failed > 0\) \{/,
    '纯跳过必须不记日志');
  // 判定必须**包住**那条 recordDiagnostic（不是并列的无关分支）
  assert.match(runner, /if \(outcome\.written > 0 \|\| outcome\.failed > 0\) \{[\s\S]{0,400}?recordDiagnostic\(/,
    'recordDiagnostic 必须在判据体内');
  // 面板状态行仍读设置里的 lastRun（不受本判定影响）——saveDiarySettings 必须在判定之前
  const saveAt = runner.indexOf('await saveDiarySettings(finalSettings)');
  const guardAt = runner.indexOf('if (outcome.written > 0 || outcome.failed > 0)');
  assert.ok(saveAt > 0 && guardAt > saveAt,
    '落盘必须在日志判定之前（状态行不能因为不记日志就丢摘要）');
});

// ---------- ⑥ i18n ----------

test('i18n：新增词条中英齐备（缺任一条界面会显示原始键名）', () => {
  const zh = read('src/i18n/locales/zh-CN/workspaceWatch.js');
  const en = read('src/i18n/locales/en/workspaceWatch.js');
  const keys = [
    'workspace.watch.roleUser',
    'workspace.watch.roleAssistant',
    'workspace.watch.expandA11y',
    'workspace.watch.collapseA11y',
    'workspace.watch.deleteThread',
    'workspace.watch.deleteThread.a11y',
    'workspace.watch.deleteThread.title',
    'workspace.watch.deleteThread.body',
    'workspace.watch.entryImage',
    'workspace.watch.noEntries',
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  }
  // 带 {name} 占位符的两条必须真的有占位符（否则确认框里看不出删的是哪一场）
  assert.ok(zh.includes('{name}'), 'zh 的删除文案要带 {name}');
  assert.ok(en.includes('{name}'), 'en 的删除文案要带 {name}');
});

// ---------- ⑦ P0-D 悬浮窗路由（截图 #257 的真因）----------

test('P0-D：工作区 scope 必须走 JS（原生大脑没有任何工具能力）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  const code = stripComments(service);
  // 根因：旧实现**先判 brain.hasConfig() 再看 scope**，于是只要用户配过 API，
  // 工作区消息就被原生大脑截走——大脑是纯流式直连、没有工具，JS 工具层永远收不到。
  // 用户看到的是助手如实说「我没有工具调用能力」（它确实没有），而不是「工具被拒绝了」。
  // 断言：工作区分支必须**在 hasConfig 判据之前**就 return，且该分支里判的是 JS 存活。
  const fnAt = code.indexOf('private fun sendChatFromInput()');
  assert.ok(fnAt > 0, 'sendChatFromInput 定位失败');
  const body = code.slice(fnAt, fnAt + 2000);
  const scopeAt = body.indexOf('if (chatScope == SCOPE_WORKSPACE)');
  const hasConfigAt = body.indexOf('if (brain.hasConfig())');
  assert.ok(scopeAt > 0, '必须有工作区 scope 分支');
  assert.ok(hasConfigAt > 0, '聊天 scope 的既有判据应保留');
  assert.ok(scopeAt < hasConfigAt,
    '工作区 scope 分支必须在 brain.hasConfig() **之前**（否则工作区消息被大脑截走，截图 #257）');
  // 该分支内必须真的走 JS 存活判定 + emit
  assert.match(body, /if \(chatScope == SCOPE_WORKSPACE\) \{[\s\S]{0,400}?ScreenOverlayModule\.isJsBridgeAlive\(\)[\s\S]{0,400}?EVENT_CHAT_SEND/,
    '工作区分支要判 JS 存活并 emit 给 JS');
  // JS 不可用时不得静默降级到大脑（那等于让助手说一段做不到的话）
  assert.match(body, /if \(chatScope == SCOPE_WORKSPACE\) \{[\s\S]{0,900}?appendChatMessage\(\s*"assistant",\s*"（工具能力需要 App 在运行中/,
    'JS 不可用时要如实说明，不得让无工具的大脑冒充');
  // 聊天 scope 的既有行为逐字不变（M2 的核心目的：app 被杀也能聊）
  assert.match(body, /if \(brain\.hasConfig\(\)\) \{[\s\S]{0,120}?sendViaBrain\(text\)/,
    '聊天 scope 仍走大脑直连（既有行为不得被本次修复顺带改掉）');
});

test('P0-D：JS 存活判定用 RN 自己的 API，不自己维护标记', () => {
  const module_ = read('plugins/screenOverlay/android/ScreenOverlayModule.kt');
  assert.match(module_, /fun isJsBridgeAlive\(\): Boolean/, '存在 JS 存活判定');
  // 用 ReactContext 的既有 API：自己维护「JS 活着」的标记需要与 RN 生命周期逐点对齐，必然漂移
  assert.match(module_, /context\.hasActiveReactInstance\(\) \|\| context\.isBridgeless\(\)/,
    '用 RN 自己的活跃判定（hasActiveReactInstance / isBridgeless）');
  // 拿不到 context 时按「不可用」返回 false（保守：宁可如实说需要打开 App）
  assert.match(module_, /fun isJsBridgeAlive\(\): Boolean \{[\s\S]{0,200}?\?: return false/,
    '拿不到 context 时返回 false');
});

// ---------- ⑧ 行数棘轮 ----------

test('行数：本轮新增/修改文件都在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'src/screenWatch/useOverlayActive.js',
    'src/screenWatch/overlayStateSync.js',
    'src/screenWatch/threadEntries.js',
    'src/screenWatch/ScreenWatchScreen.js',
    'src/workspace/screen/ScreenWatchPanel.js',
    'src/screenWatch/overlay.js',
    'src/screenWatch/overlayConfirmBridge.js',
    'src/diary/runDiary.js',
  ]) {
    const lines = count(read(file));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
});
