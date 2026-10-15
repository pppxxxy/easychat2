// FEAT-AC4 P0-A：悬浮窗写模式解锁 + 窗内确认卡。
//
// 这一批测三件事：
//   ① 纯层 OverlayConfirmRegistry —— 挂起/结算/超时/竞态（Node 直测，注入定时器）
//   ② 解锁根因 —— ScreenWatchScreen 不再硬编码 `mode: 'read'` / `confirm: () => false`
//   ③ 原生确认卡与模式徽标 —— Kotlin 源码断言（真编译靠 CI）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OverlayConfirmRegistry,
  OVERLAY_CONFIRM_SUMMARY_MAX,
  OVERLAY_CONFIRM_TIMEOUT_MS,
  normalizeOverlayConfirmRequest,
  renderOverlayConfirmSummary,
} from '../src/screenWatch/overlayConfirm.js';
import {
  OVERLAY_EVENT_CONFIRM_RESULT,
  parseConfirmResultEvent,
} from '../src/screenWatch/overlayEvents.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// ---------- 纯层：载荷归一 ----------

test('载荷归一：缺 id → null（无法归属的请求不许挂起）', () => {
  assert.equal(normalizeOverlayConfirmRequest({}), null);
  assert.equal(normalizeOverlayConfirmRequest({ id: '   ' }), null);
  assert.equal(normalizeOverlayConfirmRequest(null), null);
});

test('载荷归一：摘要截断到上限；空摘要走调用方给的 i18n 兜底', () => {
  const long = 'x'.repeat(1000);
  assert.equal(normalizeOverlayConfirmRequest({ id: 'a', summary: long }).summary.length,
    OVERLAY_CONFIRM_SUMMARY_MAX);
  // 空摘要 + 有兜底 → 用兜底（不硬编码中文：纯层不许写死文案）
  assert.equal(
    normalizeOverlayConfirmRequest({ id: 'a', summary: '  ', fallbackSummary: 'FALLBACK' }).summary,
    'FALLBACK'
  );
  // 都没有 → 退到键名（不是中文文案）
  assert.equal(normalizeOverlayConfirmRequest({ id: 'a' }).summary, 'confirm');
});

test('载荷归一：超时缺省/非法时回落默认 60s', () => {
  assert.equal(normalizeOverlayConfirmRequest({ id: 'a' }).timeoutMs, OVERLAY_CONFIRM_TIMEOUT_MS);
  assert.equal(OVERLAY_CONFIRM_TIMEOUT_MS, 60000, '与原生 CONFIRM_TIMEOUT_MS 同值');
  for (const bad of [0, -1, NaN, 'x']) {
    assert.equal(normalizeOverlayConfirmRequest({ id: 'a', timeoutMs: bad }).timeoutMs,
      OVERLAY_CONFIRM_TIMEOUT_MS);
  }
  assert.equal(normalizeOverlayConfirmRequest({ id: 'a', timeoutMs: 5000 }).timeoutMs, 5000);
});

// ---------- 纯层：注册表（含竞态）----------

// 可控定时器：把「超时」变成可手动触发的确定性事件。
function makeFakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const handle = ++seq;
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    /** 触发所有到期的定时器（无条件触发，测试里只关心「到点会怎样」）。 */
    fireAll() {
      const entries = [...timers.entries()];
      timers.clear();
      entries.forEach(([, item]) => item.fn());
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

test('注册表：允许 → 恰好结算一次，并把定时器清掉', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const results = [];
  registry.register({ id: 'c1', summary: 's' }, r => results.push(r), timers);
  assert.equal(registry.size, 1);
  assert.equal(timers.pendingCount, 1, '挂起时应有超时定时器');

  assert.equal(registry.settleById('c1', { approved: true, reason: 'approved' }, timers), true);
  assert.deepEqual(results, [{ approved: true, reason: 'approved' }]);
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0, '结算后必须清定时器（否则泄漏 + 迟到触发）');
});

test('注册表：超时 → 按拒绝结算（agent 循环不能无限挂起）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const results = [];
  registry.register({ id: 'c1', summary: 's' }, r => results.push(r), timers);
  timers.fireAll();
  assert.deepEqual(results, [{ approved: false, reason: 'timeout' }]);
  assert.equal(registry.size, 0);
});

test('注册表：**幂等** —— 超时后再点允许不会二次结算（这是防「执行了本该拒绝的操作」）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const results = [];
  registry.register({ id: 'c1', summary: 's' }, r => results.push(r), timers);
  timers.fireAll();                                   // 超时 → 拒绝
  // 用户这时才点「允许」（迟到事件）：必须被忽略
  assert.equal(registry.settleById('c1', { approved: true, reason: 'approved' }, timers), false);
  assert.deepEqual(results, [{ approved: false, reason: 'timeout' }], '只结算一次，且是拒绝');
});

test('注册表：重复点允许/拒绝只结算一次', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const results = [];
  registry.register({ id: 'c1', summary: 's' }, r => results.push(r), timers);
  assert.equal(registry.settleById('c1', { approved: true, reason: 'approved' }, timers), true);
  assert.equal(registry.settleById('c1', { approved: false, reason: 'denied' }, timers), false);
  assert.equal(results.length, 1);
});

test('注册表：未知 id / 空 id 结算返回 false（不抛）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  assert.equal(registry.settleById('nope', { approved: true }, timers), false);
  assert.equal(registry.settleById('', { approved: true }, timers), false);
  assert.equal(registry.settleById(null, { approved: true }, timers), false);
});

test('注册表：同 id 重复挂起被拒（不覆盖已挂起的那个）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const first = [];
  const second = [];
  assert.equal(registry.register({ id: 'dup', summary: 'a' }, r => first.push(r), timers), true);
  assert.equal(registry.register({ id: 'dup', summary: 'b' }, r => second.push(r), timers), false);
  assert.equal(registry.size, 1);
  registry.settleById('dup', { approved: true, reason: 'approved' }, timers);
  assert.equal(first.length, 1, '第一个才是被结算的那个');
  assert.equal(second.length, 0, '被拒的注册不该拿到结算');
});

test('注册表：settleAll 全按拒绝（服务销毁 / app 退出不留悬空）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  const results = [];
  registry.register({ id: 'a', summary: 's' }, r => results.push(['a', r]), timers);
  registry.register({ id: 'b', summary: 's' }, r => results.push(['b', r]), timers);
  assert.equal(registry.settleAll('aborted', timers), 2);
  assert.deepEqual(results.map(item => item[0]).sort(), ['a', 'b']);
  assert.ok(results.every(item => item[1].approved === false && item[1].reason === 'aborted'));
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});

test('注册表：结算回调抛错不影响注册表状态（已被清干净）', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  registry.register({ id: 'boom', summary: 's' }, () => { throw new Error('callback blew up'); }, timers);
  assert.equal(registry.settleById('boom', { approved: true }, timers), true);
  assert.equal(registry.size, 0, '回调抛错也必须已从表里移除');
});

test('注册表：自定义超时时长被采用', () => {
  const timers = makeFakeTimers();
  const registry = new OverlayConfirmRegistry();
  let seen = null;
  registry.register({ id: 'c', summary: 's', timeoutMs: 1234 }, () => {}, {
    ...timers,
    setTimeout(fn, ms) { seen = ms; return timers.setTimeout(fn, ms); },
  });
  assert.equal(seen, 1234);
});

// ---------- 纯层：摘要渲染 ----------

test('摘要渲染：优先用工具的 render 函数（AC1/AC2 的既有摘要）', () => {
  const out = renderOverlayConfirmSummary({
    name: 'set_app_setting',
    args: { key: 'tts.autoBroadcast' },
    render: () => '将把语音播报从关改为开',
  });
  assert.equal(out, '将把语音播报从关改为开');
});

test('摘要渲染：render 抛错 → 兜底（确认卡不能因此弹不出来）', () => {
  const out = renderOverlayConfirmSummary({
    name: 'control_music',
    args: { action: 'play' },
    render: () => { throw new Error('boom'); },
  });
  assert.match(out, /control_music/);
  assert.match(out, /play/);
});

test('摘要渲染：无 render → 工具名 + 参数摘要；都空也有兜底名', () => {
  assert.match(renderOverlayConfirmSummary({ name: 'x', args: { a: 1 } }), /x/);
  assert.equal(renderOverlayConfirmSummary({}), '未知操作');
  // 参数不可序列化也不抛
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(renderOverlayConfirmSummary({ name: 'y', args: cyclic }), /y/);
});

test('摘要渲染：超长摘要被截断到上限（卡片撑不爆）', () => {
  const out = renderOverlayConfirmSummary({ name: 'n', render: () => 'z'.repeat(900) });
  assert.equal(out.length, OVERLAY_CONFIRM_SUMMARY_MAX);
});

// ---------- 事件解析 ----------

test('确认结果事件：缺 id → null（无法归属的结果不许结算）', () => {
  assert.equal(parseConfirmResultEvent({}), null);
  assert.equal(parseConfirmResultEvent({ approved: true }), null);
  assert.equal(parseConfirmResultEvent(null), null);
});

test('确认结果事件：reason 缺省时按 approved 推断', () => {
  assert.deepEqual(parseConfirmResultEvent({ id: 'a', approved: true }),
    { id: 'a', approved: true, reason: 'approved' });
  assert.deepEqual(parseConfirmResultEvent({ id: 'a', approved: false }),
    { id: 'a', approved: false, reason: 'denied' });
  // 原生给的 timeout 要原样保留（助手收尾文案不同）
  assert.deepEqual(parseConfirmResultEvent({ id: 'a', approved: false, reason: 'timeout' }),
    { id: 'a', approved: false, reason: 'timeout' });
  // approved 非布尔真值一律视为 false（不执行的方向）
  assert.equal(parseConfirmResultEvent({ id: 'a', approved: 'yes' }).approved, false);
});

test('事件名与原生同值（跨语言契约）', () => {
  assert.equal(OVERLAY_EVENT_CONFIRM_RESULT, 'ScreenOverlay:onConfirmResult');
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes(`const val EVENT_CONFIRM_RESULT = "${OVERLAY_EVENT_CONFIRM_RESULT}"`),
    'Kotlin 侧事件名必须与 JS 常量逐字一致');
});

// ---------- 解锁根因（本任务的核心）----------

test('解锁：悬浮窗不再硬编码只读、不再一律自动拒绝', () => {
  const hook = read('src/screenWatch/useOverlayChatSend.js');
  // ⚠️ 剥注释再判：本文件的注释正解释着「原先硬编码 mode:'read'」这段历史，
  // 按整文件匹配会自己打自己（本仓反复踩过的假阳性形态）。
  const code = hook.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  // 旧实现的两行必须彻底消失（它们是「悬浮窗干不了活」的单一根因）
  assert.equal(/mode:\s*'read'/.test(code), false, '不得再硬编码只读模式');
  assert.equal(/confirm:\s*async\s*\(\)\s*=>\s*false/.test(code), false, '不得再一律自动拒绝');
  // 新模式：跟随 app 工作区设置
  assert.ok(code.includes('getWorkspaceSettings'), '模式应从 app 工作区设置读');
  assert.match(code, /const workspaceMode = \(workspaceSettings && workspaceSettings\.mode\) \|\| 'ask'/,
    '缺省 ask（与 app 面板同口径）');
  assert.ok(code.includes('mode: workspaceMode'), '把模式传给回合');
  // allowWrite 必须一起传（漏了它即便 mode=write 也可能被 headlessAgent 降级）
  assert.ok(code.includes("allowWrite: workspaceMode === 'write'"),
    'allowWrite 要与 mode 同源（app 面板也是这么传的）');
  // 确认走窗内卡片
  assert.ok(code.includes('confirm: confirmRef.current'), '确认走窗内卡片钩子');
  assert.ok(code.includes('createOverlayConfirmHandler'), '钩子来自窗内确认编排');
  // 权限规则也要接（否则写工具上的手写 deny 变死键）。
  // ⚠️ 必须断言**真的调用了**——只断言 includes('readToolPermissionRules') 时，
  // 留个 import 行就能蒙混（注入验证抓到的第 5 次同形态）。
  assert.match(code, /permissionRules: async \(\) => readToolPermissionRules\(/,
    '权限规则必须真的作为 permissionRules 传进回合');
  assert.match(code, /await readHookPermissionRules\(storeRef\.current, 'workspace'\)/,
    'hooks.json 规则要经合并入口读（与工作区聊天同一条）');
  // 模式徽标：'read' 只允许出现在「徽标取值的三目」里，不允许出现在 mode 传参里
  assert.ok(code.includes('setOverlayScopeMode'), '推送模式徽标');
  assert.match(code, /workspaceMode === 'write' \? 'write' : 'read'/,
    'ask 档按只读显示（与 canRunTool 实际放行一致）');
  // 'read' 只出现在徽标三目这一处（mode 传参用的是变量）
  assert.equal((code.match(/'read'/g) || []).length, 1,
    "'read' 字面量只应在徽标三目里出现一次（mode 传参必须用变量）");
});

test('解锁：ScreenWatchScreen 已把该块外提（行数棘轮），且不再自己拼管线', () => {
  const screen = read('src/screenWatch/ScreenWatchScreen.js');
  assert.ok(screen.includes('useOverlayChatSend'), '改用外提的 hook');
  // 外提后这些不该再出现在屏幕文件里（否则是重复实现）
  assert.equal(/runWorkspaceWatchTurn/.test(screen), false, '屏幕文件不该再直接调回合');
  assert.equal(/runHeadlessAgent/.test(screen), false, '屏幕文件不该再直接调 agent');
});

test('确认桥：后台 / 老构建 / 推送失败 一律按拒绝（问不到用户 = 不执行）', () => {
  const bridge = read('src/screenWatch/overlayConfirmBridge.js');
  // 后台不推（推了也没人看）。
  // ⚠️ 必须断言**分支体内**的行为，不能只靠邻近正则——早先写的
  // `/AppState\.currentState === 'active'[\s\S]{0,400}?resolve\(false\)/` 是空转的：
  // 把 `if (!foreground)` 改成 `if (false)` 之后，那行 `foreground = ...` 还在、
  // 别处也有 resolve(false)，正则照样匹配（注入验证抓到的）。
  assert.match(bridge, /const foreground = AppState\.currentState === 'active';/,
    '读取前台状态');
  assert.match(bridge, /if \(!foreground\) \{[\s\S]{0,500}?resolve\(false\);[\s\S]{0,120}?return;/,
    '不在前台必须 resolve(false) 并 return（不挂起、不推卡片）');
  // 推送失败 → 立刻结算为拒绝，不把 agent 悬着
  assert.match(bridge, /if \(!ok\) ensureRegistry\(\)\.settleById\(id, \{ approved: false, reason: 'unavailable' \}\)/,
    '推卡片失败要立刻按拒绝结算');
  // 注册失败（同 id 已挂起 / 载荷不可用）也要结算
  assert.match(bridge, /if \(!registered\) \{[\s\S]{0,120}?resolve\(false\);/,
    '注册失败要按拒绝');
  // 兜底文案走 i18n（纯层不许硬编码中文）
  assert.ok(bridge.includes("tActive('screenWatch.overlay.confirm.fallback')"),
    '兜底文案走 i18n');
});

// ---------- 原生（Kotlin 源码断言）----------

test('原生：确认卡有允许/拒绝两键，且点击后禁用（防连点重复结算）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('fun pushConfirmCard('), '推送入口存在');
  assert.ok(service.includes('makeConfirmCard('), '卡片构造存在');
  assert.ok(service.includes('button("允许")') && service.includes('button("拒绝")'), '两键齐备');
  // 结算一次：settled 标记 + 点后禁用
  assert.match(service, /var settled = false/, '有一次性结算标记');
  assert.match(service, /isEnabled = false/, '点过要禁用两键');
});

test('原生：确认卡超时按拒绝（默认 60s，与 JS 同值）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.match(service, /private const val CONFIRM_TIMEOUT_MS = 60000L/);
  assert.match(service, /postDelayed\(\{ finish\(false, "timeout"\) \}, wait\)/,
    '超时必须走拒绝分支');
  assert.ok(service.includes('if (timeoutMs > 0) timeoutMs else CONFIRM_TIMEOUT_MS'),
    'JS 给 0 时用原生默认');
});

test('原生：确认卡插进聊天流（不弹全屏 Alert——那会盖住用户正在看的画面）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.equal(/AlertDialog/.test(service), false, '不得用全屏对话框');
  assert.match(service, /fun pushConfirmCard\([\s\S]{0,600}?list\.addView\(card\)/,
    '卡片要插进消息列表');
  // 卡片也要进留档（否则收起/展开重建时它消失，而 JS 还在等）
  assert.match(service, /chatHistory\.add\("assistant" to "\[需要确认\] \$summary"\)/,
    '卡片要进留档，否则重建后消失而 JS 仍挂起');
});

test('原生：模式徽标只显示不改（切换仍回 app 面板）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('fun setScopeModeLabel('), '徽标入口存在');
  assert.match(service, /"write" -> "可改"[\s\S]{0,120}?"read" -> "只读"/, '两档文案');
  const module_ = read('plugins/screenOverlay/android/ScreenOverlayModule.kt');
  assert.ok(module_.includes('fun setScopeModeLabel('), '模块方法存在');
  assert.ok(module_.includes('fun pushConfirmCard('), '确认卡模块方法存在');
  // 失败要 reject 而非崩
  assert.match(module_, /fun pushConfirmCard\([\s\S]{0,700}?catch \(e: Exception\)[\s\S]{0,200}?promise\.reject/);
});

test('JS 桥：两个新方法在旧构建上安全降级', () => {
  const overlay = read('src/screenWatch/overlay.js');
  assert.ok(overlay.includes('export async function pushOverlayConfirm('));
  assert.ok(overlay.includes('export function addConfirmResultListener('));
  assert.ok(overlay.includes('export async function setOverlayScopeMode('));
  assert.match(overlay, /typeof module\.pushConfirmCard !== 'function'[\s\S]{0,80}?return false/);
  assert.match(overlay, /typeof module\.setScopeModeLabel !== 'function'[\s\S]{0,80}?return false/);
});
