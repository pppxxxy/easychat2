// FEAT-AC8：布尔字符串宽容 + 确认防环 + 打点补全。
//
// 来源：用户 00:35 真机复测 + 诊断日志（AC7 的打点终于上班了，直接定罪）。
// 四个根因（本轮任务书 §一，全部对码核实；BUG-D 的**措辞**需更正，见最后一组）：
//   BUG-A 布尔字段拒绝字符串 'true' → 模型合规重试 → 确认卡连环弹（当晚 4 允许 + 1 拒绝）
//   BUG-B 连环弹卡烧用户（即使修了 A 也要防）
//   BUG-C 线程列表只在挂载/开悬浮窗时刷新 →「（暂无内容）」真伪难辨
//   BUG-D 5 次工具调用在日志里隐形（**真因是 onTurnEvent 从未被注入**，不是「没人调用」）
//
// 测试分工（仓库纪律）：纯逻辑真跑；接线层源码断言，且断言**调用点/分支体**而非名字。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateSettingValue,
  coerceSettingValue,
  parseBooleanString,
} from '../src/workspace/appSettingsSchema.js';
import {
  ConfirmBudget,
  CONFIRM_REPEAT_BUDGET,
  confirmSignature,
  repeatGuardMessage,
} from '../src/agent/tools/confirmBudget.js';
import {
  TURN_EVENTS,
  formatTurnEvent,
} from '../src/screenWatch/turnDiagnostics.js';
import { summarizeToolCall } from '../src/screenWatch/overlaySummary.js';
import {
  subscribeThreadsChanged,
  notifyThreadsChanged,
  __resetThreadsChanged,
  __threadsChangedListenerCount,
} from '../src/screenWatch/threadEvents.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function stripComments(source) {
  return source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ---------- ① BUG-A 根因：布尔字符串宽容 ----------

test('BUG-A：布尔字段接受字符串 true/false（当晚场景：模型传 "true"）', () => {
  // 现场证据：确认卡显示 {"key":"tts.autoBroadcast","value":"true"} —— 带引号。
  // JSON 里布尔不带引号、字符串才带 ⇒ 模型传的是字符串。
  // 而工具 schema 的 value **刻意不声明 type**（类型随键而变），模型这么传并不违规。
  assert.equal(validateSettingValue('tts.autoBroadcast', 'true'), null, "'true' 必须放行");
  assert.equal(validateSettingValue('tts.autoBroadcast', 'false'), null, "'false' 必须放行");
  // 大小写不敏感 + 容忍首尾空白（模型输出的常见形态）
  assert.equal(validateSettingValue('tts.autoBroadcast', 'TRUE'), null, '大小写不敏感');
  assert.equal(validateSettingValue('tts.autoBroadcast', ' False '), null, '容忍首尾空白');
  // 真布尔照旧放行（回归）
  assert.equal(validateSettingValue('tts.autoBroadcast', true), null);
  assert.equal(validateSettingValue('tts.autoBroadcast', false), null);
  // 第二个布尔键同样适用（diary.enabled 也是 boolean）
  assert.equal(validateSettingValue('diary.enabled', 'true'), null);
});

test('BUG-A：有歧义的字符串**仍然拒绝**（放宽不等于不校验）', () => {
  // 只放行语义无歧义的 'true'/'false'。'yes'/'1'/'on'/'' 的含义需要猜——不猜。
  for (const bad of ['yes', 'no', '1', '0', 'on', 'off', '', '   ', 'tru', 'truee', 1, 0, null, undefined, {}]) {
    const result = validateSettingValue('tts.autoBroadcast', bad);
    assert.ok(typeof result === 'string' && result.length > 0,
      `${JSON.stringify(bad)} 必须被拒绝（有歧义不猜）`);
  }
  // 拒绝文案保持既有口径（含「需要 true 或 false」）
  assert.match(validateSettingValue('tts.autoBroadcast', 'yes'), /需要 true 或 false/);
});

test('BUG-A：字符串必须被**归一**成布尔（只放宽校验不归一会写坏存储）', () => {
  // 这是最容易漏的一半：`autoBroadcast: 'false'` 是 truthy —— 比拒绝更糟
  //（设置看着改了、实际行为反了）。校验与归一必须成对。
  assert.equal(coerceSettingValue('tts.autoBroadcast', 'true'), true);
  assert.equal(coerceSettingValue('tts.autoBroadcast', 'false'), false);
  assert.equal(coerceSettingValue('tts.autoBroadcast', ' TRUE '), true);
  // 真布尔原样
  assert.equal(coerceSettingValue('tts.autoBroadcast', true), true);
  assert.equal(coerceSettingValue('tts.autoBroadcast', false), false);
  // 非法值原样返回（校验已先拒，这里不负责兜底）
  assert.equal(coerceSettingValue('tts.autoBroadcast', 'yes'), 'yes');
  // 归一后的值必然是布尔（写进存储的类型）
  assert.equal(typeof coerceSettingValue('tts.autoBroadcast', 'false'), 'boolean');
});

test('BUG-A：parseBooleanString 的边界（只认两个字面量）', () => {
  assert.equal(parseBooleanString('true'), true);
  assert.equal(parseBooleanString('false'), false);
  assert.equal(parseBooleanString(' True '), true);
  for (const bad of ['yes', '1', '', 'truex', 1, true, null, undefined, {}, []]) {
    assert.equal(parseBooleanString(bad), undefined, `${JSON.stringify(bad)} 应返回 undefined`);
  }
});

test('BUG-A 回归：枚举的既有字符串宽容不受影响', () => {
  // 布尔宽容是「与枚举对称」，不是替代——枚举那条路必须原样工作。
  assert.equal(validateSettingValue('musicClip.clipSeconds', '30'), null, "枚举 '30' 仍放行");
  assert.equal(typeof coerceSettingValue('musicClip.clipSeconds', '30'), 'number', "'30' 仍归一成数字");
});

test('BUG-A 回归：读路径不受影响（get 不经过 validate/coerce）', () => {
  // 任务书 §二 P0-A 明确要求 get_app_setting 读路径回归不受影响。
  // 读路径走 PANEL_READERS + spec.read，不经过本次改动的两个函数——
  // 用源码结构钉住：读工具的定义里不得出现 validateSettingValue。
  const tools = read('src/workspace/toolDefs/appSettingsTools.js');
  const getToolAt = tools.indexOf('const GET_APP_SETTING_TOOL');
  const setToolAt = tools.indexOf('const SET_APP_SETTING_TOOL');
  assert.ok(getToolAt > 0 && setToolAt > getToolAt, '读/写工具定义定位失败');
  const getBlock = tools.slice(getToolAt, setToolAt);
  assert.equal(/validateSettingValue/.test(getBlock), false, '读工具不得做值校验（读不需要）');
  assert.equal(/coerceSettingValue/.test(getBlock), false, '读工具不得做值归一');
});

test('BUG-A：校验在归一**之前**，且拒绝时**不归一**（顺序契约）', () => {
  // 任务书指出的链路：validate 在前、coerce 在后 ⇒ 校验拒绝后 coerce 没机会跑。
  // 修法是让 validate **接受**字符串布尔，而不是把顺序倒过来。
  // 理由：顺序倒过来会把非法值先归一（'yes' 被 coerce 成什么？）——
  // 「校验失败不猜不修」是本文件既有的硬纪律，不能为了修这个 bug 破掉。
  const tools = read('src/workspace/toolDefs/appSettingsTools.js');
  const validateAt = tools.indexOf('const invalid = validateSettingValue(key, args.value)');
  const coerceAt = tools.indexOf('const value = coerceSettingValue(key, args.value)');
  assert.ok(validateAt > 0, 'set 工具必须先校验');
  assert.ok(coerceAt > validateAt, '归一只能在校验通过之后');
});

// ---------- ② BUG-B：同签名确认预算 ----------

test('确认预算：首次与第 2 次询问，第 3 次起拒绝（当晚 4 次允许的形态）', () => {
  const budget = new ConfirmBudget();
  assert.equal(CONFIRM_REPEAT_BUDGET, 2, '阈值是拍板值 2（首次 + 1 次重试）');
  // 逐次确认语义不变：首次必须问
  assert.equal(budget.shouldAsk('set_app_setting|{...}'), true, '第 1 次必须弹卡');
  assert.equal(budget.shouldAsk('set_app_setting|{...}'), true, '第 2 次给一次重试机会');
  assert.equal(budget.shouldAsk('set_app_setting|{...}'), false, '第 3 次不再打扰用户');
  assert.equal(budget.shouldAsk('set_app_setting|{...}'), false, '此后一直拒绝');
  assert.equal(budget.askedCount('set_app_setting|{...}'), 2, '询问次数封顶在预算上');
});

test('确认预算：**不同参数不共享预算**（改参数是正常行为，不是重试）', () => {
  const budget = new ConfirmBudget();
  const sigA = confirmSignature('set_app_setting', { key: 'tts.autoBroadcast', value: true });
  const sigB = confirmSignature('set_app_setting', { key: 'tts.autoBroadcast', value: false });
  const sigC = confirmSignature('set_app_setting', { key: 'appearance.theme', value: 'dark' });
  assert.equal(budget.shouldAsk(sigA), true);
  assert.equal(budget.shouldAsk(sigA), true);
  assert.equal(budget.shouldAsk(sigA), false, 'A 用尽');
  // B / C 各自拥有完整预算
  assert.equal(budget.shouldAsk(sigB), true, '换参数应重新获得确认机会');
  assert.equal(budget.shouldAsk(sigC), true, '换键同理');
});

test('确认预算：签名与键序无关（同一组参数不许因键序抖动被当成两次）', () => {
  const one = confirmSignature('set_app_setting', { key: 'a', value: true });
  const two = confirmSignature('set_app_setting', { value: true, key: 'a' });
  assert.equal(one, two, '键序不同但内容相同 ⇒ 同一签名');
  // 不同工具绝不共享（哪怕参数一样）
  assert.notEqual(confirmSignature('set_app_setting', { x: 1 }), confirmSignature('control_music', { x: 1 }));
});

test('确认预算：签名的各种值形状都稳定（嵌套 / 数组 / 空 / 缺失）', () => {
  // 嵌套对象同样按键序归一（递归稳定序列化）
  assert.equal(
    confirmSignature('t', { a: { z: 1, y: 2 }, b: [1, 2] }),
    confirmSignature('t', { b: [1, 2], a: { y: 2, z: 1 } }),
    '嵌套对象也要键序稳定'
  );
  // 数组顺序**有意义**，不得被当成同签名（[1,2] 与 [2,1] 是不同参数）
  assert.notEqual(confirmSignature('t', [1, 2]), confirmSignature('t', [2, 1]));
  // 标量 / null / undefined 都要能算出来（不抛）
  for (const value of [1, 'x', true, null, undefined, 0, false]) {
    assert.doesNotThrow(() => confirmSignature('t', value), `${JSON.stringify(value)} 不该抛`);
    assert.ok(confirmSignature('t', value).startsWith('t'), '签名必须以工具名开头');
  }
  // 参数缺失与显式 null **同一签名**（实现刻意把 undefined 归成 null：
  // 「没传参数」与「传了 null」在工具语义上是同一件事，不该占两个预算）。
  assert.equal(confirmSignature('t'), 't|null');
  assert.equal(confirmSignature('t', undefined), 't|null');
  assert.equal(confirmSignature('t', null), 't|null');
  // 序列化失败（循环引用）时必须**退化为工具名**而不是抛（防环不能因签名算不出而失效）
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => confirmSignature('t', cyclic), '循环引用不得抛');
  assert.equal(confirmSignature('t', cyclic), 't', '算不出摘要时退化为只按工具名');
});

test('确认预算：按回合清零（新一轮发话重新获得完整机会）', () => {
  const budget = new ConfirmBudget();
  const sig = confirmSignature('set_app_setting', { key: 'k', value: true });
  budget.shouldAsk(sig);
  budget.shouldAsk(sig);
  assert.equal(budget.shouldAsk(sig), false, '本回合已用尽');
  budget.reset();
  assert.equal(budget.shouldAsk(sig), true, '新回合应重新获得完整预算');
});

test('确认预算：签名缺失时不启用防环（宁可多问，不可误拒）', () => {
  const budget = new ConfirmBudget();
  assert.equal(budget.shouldAsk(''), true);
  assert.equal(budget.shouldAsk(''), true);
  assert.equal(budget.shouldAsk(''), true, '签名算不出来时不得因此拒绝用户的确认机会');
  assert.equal(budget.shouldAsk(null), true);
});

test('确认预算：repeatGuardMessage 给模型明确收尾指令（否则它会继续重发）', () => {
  const message = repeatGuardMessage('set_app_setting');
  assert.match(message, /set_app_setting/, '要说明是哪个工具');
  assert.match(message, /2/, '要说清已确认过几次');
  assert.match(message, /未执行/, '必须明确「没有执行」——不能含糊');
  // 最关键的一句：告诉模型**停止重试并给手动指引**，否则它只看到「拒绝」会继续重发
  assert.match(message, /停止重试|停止再次询问/, '必须要求模型停止重试');
  assert.match(message, /手动/, '必须要求给用户手动操作指引');
});

test('确认预算：budget 非法时退回默认值（不因配置错误失去防环）', () => {
  for (const bad of [0, -1, NaN, 'x', null, undefined]) {
    const budget = new ConfirmBudget({ budget: bad });
    assert.equal(budget.budget, CONFIRM_REPEAT_BUDGET, `${JSON.stringify(bad)} 应退回默认预算`);
  }
});

// ---------- ③ 接线：预算真的接进了 runTool ----------

test('接线：runTool 里预算用尽 → 按**拒绝**结算（方向不是放行）', () => {
  const registry = stripComments(read('src/agent/tools/registry.js'));
  // 预算判定必须在 confirm 调用**之前**（用尽就不该弹卡）
  const budgetAt = registry.indexOf('budget.shouldAsk(confirmSignature(tool.name, args))');
  // ⚠️ FEAT-AC11 P1-4：confirm 载荷新增 attempt / batchRemaining（弹窗标注重试与进度）。
  // 断言不再钉死整串参数表，而是钉「调用点存在」+「位置在预算判定之后」——
  // 钉死整串会让每次给弹窗加信息字段都要改这条断言（而它想守的只是**先后顺序**）。
  const confirmAt = registry.indexOf('ctx.confirm({ name: tool.name, args,');
  assert.ok(budgetAt > 0, 'runTool 必须做预算判定');
  assert.ok(confirmAt > budgetAt, '预算判定必须在弹卡之前（用尽即不弹）');
  // 用尽时必须返回**错误结果**（toErrorResult = 未执行），绝不是放行
  assert.match(registry, /if \(budget && !budget\.shouldAsk\(confirmSignature\(tool\.name, args\)\)\) \{[\s\S]{0,200}?return toErrorResult\(repeatGuardMessage/,
    '预算用尽要按拒绝结算并给模型话术');
  // ⚠️ 反向守护：这条路径绝不能出现「放行」写法（approved = true / 直接 return 执行）
  const guardBlock = registry.slice(budgetAt, budgetAt + 400);
  assert.equal(/approved = true/.test(guardBlock), false, '预算用尽绝不能放行');
});

test('接线：确认预算由**回合**持有（每回合新建，不是模块级单例）', () => {
  const loop = stripComments(read('src/agent/loop.js'));
  // 模块级单例会把「上一轮用户已点过」错算进新一轮，且并发回合互相吃预算
  assert.match(loop, /const confirmBudget = new ConfirmBudget\(\);/,
    '每回合必须新建一个预算实例');
  assert.match(loop, /outcome = await runTool\(call, \{[\s\S]{0,400}?confirmBudget,/,
    '预算必须经 ctx 传进 runTool');
  // 不得做成模块级 let/const（那会被跨回合复用）
  assert.equal(/^let confirmBudget/m.test(loop), false, '不得做成模块级单例');
});

// ---------- ④ BUG-C：列表刷新 + 落库留痕 ----------

test('BUG-C：面板订阅线程变更（回合结束即刷新，不再等下次挂载）', () => {
  const panel = read('src/workspace/screen/ScreenWatchPanel.js');
  assert.match(panel, /subscribeThreadsChanged\(\(\) => \{[\s\S]{0,160}?refresh\(\)/,
    '面板必须订阅变更并刷新');
  // 退订必须返回（useEffect 的 cleanup）——直接返回 subscribe 的结果
  assert.match(panel, /useEffect\(\(\) => subscribeThreadsChanged\(/, '订阅要作为 effect 的 cleanup 返回');
  // 回合结束必须广播（悬浮窗路径）
  const overlayTurn = read('src/screenWatch/overlayWorkspaceTurn.js');
  assert.match(overlayTurn, /notifyThreadsChanged\(\)/, '回合结束要广播');
  // 成功与异常两条收尾都要广播（漏一条 = 那条路径面板仍然陈旧）
  const broadcastCount = (overlayTurn.match(/notifyThreadsChanged\(\)/g) || []).length;
  assert.ok(broadcastCount >= 2, `成功/异常两条收尾都要广播，实际 ${broadcastCount} 处`);
});

test('BUG-C：threadEvents 是幂等订阅、广播不抛、单订阅者坏掉不影响其余', () => {
  __resetThreadsChanged();
  try {
    let a = 0;
    let b = 0;
    const offA = subscribeThreadsChanged(() => { a += 1; });
    const offB = subscribeThreadsChanged(() => { b += 1; throw new Error('坏订阅者'); });
    assert.equal(__threadsChangedListenerCount(), 2);
    notifyThreadsChanged();
    assert.equal(a, 1, '正常订阅者收到通知');
    assert.equal(b, 1, '抛错的订阅者也收到了（只是自己炸了）');
    // 退订幂等（React 严格模式会双调用 cleanup）
    offB();
    offB();
    offA();
    offA();
    assert.equal(__threadsChangedListenerCount(), 0);
    // 无订阅者时广播不抛
    assert.doesNotThrow(() => notifyThreadsChanged());
    // 非函数订阅被忽略（不污染订阅表）
    subscribeThreadsChanged(null);
    assert.equal(__threadsChangedListenerCount(), 0, '非函数不得进订阅表');
  } finally {
    __resetThreadsChanged();
  }
});

test('BUG-C：落库留痕只记 id 尾 4 位 + role + ok（不含正文）', () => {
  const turn = stripComments(read('src/screenWatch/workspaceWatchTurn.js'));
  assert.match(turn, /threadTail: String\(info\.threadId \|\| ''\)\.slice\(-4\)/,
    '只取线程 id 尾 4 位（够定位又不把 id 全文写进日志）');
  // 留痕字段白名单必须包含这两个（否则打点里看不到）
  const diagnostics = read('src/screenWatch/turnDiagnostics.js');
  assert.match(diagnostics, /const FIELDS = Object\.freeze\(\[[^\]]*'threadTail'[^\]]*'role'/,
    'threadTail / role 必须在字段白名单里');
  // thread-append 必须登记（否则渲染成 turn-unknown）
  assert.ok(TURN_EVENTS.includes('thread-append'), 'thread-append 必须登记为已知事件');
});

// ---------- ⑤ BUG-D：打点补全（真因：onTurnEvent 从未被注入）----------

test('BUG-D：formatTurnEvent 保留 falsy 有意义值（ok=false 归一成 fail / elapsed=0）', () => {
  // FEAT-AC9 P0-3：ok 由 true/false 归一成 'ok' / 'fail' 字面量。
  // 重点不变——成败**不能因为取值是 falsy 而消失**。
  assert.equal(formatTurnEvent('turn-tool', { tool: 'set_app_setting', ok: false }),
    'turn-tool tool=set_app_setting ok=fail');
  assert.equal(formatTurnEvent('turn-done', { elapsed: 0 }), 'turn-done elapsed=0ms');
  // 缺字段仍然省略
  assert.equal(formatTurnEvent('turn-tool', { tool: 'x' }), 'turn-tool tool=x');
});

test('BUG-D：onTurnEvent 从宿主一路贯通到 agent 循环（真因是它从未被注入）', () => {
  // ⚠️ 任务书 §一 BUG-D 称「turn-tool 定义了全仓无人调用（git grep 证实）」。
  // 核实结论：**措辞有误**——loop.js 里 turn-tool 的 emit 一直在（:387/:417 两处），
  // 真正的问题是**没有任何调用方把 onTurnEvent 传进 runAgentTurn**
  // ⇒ `typeof options.onTurnEvent === 'function'` 恒为 false ⇒ 打点全部静默丢弃。
  // 症状（5 次工具调用隐形）是真的，机制不同。以下按**注入链**钉住修复。
  const loop = read('src/agent/loop.js');
  assert.match(loop, /emitTurnEvent\('turn-tool'/, 'loop 里确实有 turn-tool 打点');
  // ① headlessAgent 必须接受并透传
  const headless = stripComments(read('src/workspace/headlessAgent.js'));
  assert.match(headless, /onTurnEvent = null,/, 'headlessAgent 必须接受 onTurnEvent');
  assert.match(headless, /\.\.\.\(typeof onTurnEvent === 'function' \? \{ onTurnEvent \} : \{\}\)/,
    'headlessAgent 必须把它透传给 runAgentTurn');
  // ② runWorkspaceWatchTurn 必须接受并透传（两条驱动路径的共同收口）
  // ⚠️ FEAT-AC9：透传的不再是 noteTurnEvent 本身，而是**回合级去重器**
  // forwardTurnEvent——内层 loop.js 也发 turn-start / turn-done，直接透传会让
  // 一个回合在日志里出现两组边界事件（探针实测 6 条而非 4 条）。
  const turn = stripComments(read('src/screenWatch/workspaceWatchTurn.js'));
  assert.match(turn, /onTurnEvent = null,/, 'runWorkspaceWatchTurn 必须接受 onTurnEvent');
  assert.match(turn, /\.\.\.\(typeof onTurnEvent === 'function' \? \{ onTurnEvent: forwardTurnEvent \} : \{\}\)/,
    'runWorkspaceWatchTurn 必须经去重器透传给 runAgent（回合级事件由本层独占）');
  // ③ 两条驱动路径都必须真的注入
  assert.match(stripComments(read('src/screenWatch/overlayWorkspaceTurn.js')), /onTurnEvent: noteTurnEvent/,
    '悬浮窗路径必须注入打点器');
  assert.match(stripComments(read('src/workspace/screen/ScreenWatchPanel.js')), /onTurnEvent: noteTurnEvent/,
    '面板路径必须注入打点器（两条路径同源）');
});

test('BUG-D：真实轮数贯通（round 不再硬编码 0）', () => {
  const turn = read('src/screenWatch/workspaceWatchTurn.js');
  // 轮数的唯一来源是 onToolEvent 的 event.round（loop.js 每轮带真实轮号）
  assert.match(turn, /maxRound = Math\.max\(maxRound, Number\(event\.round\)\)/,
    '必须从 onToolEvent 累积真实轮数');
  assert.match(turn, /onToolEvent: forwardToolEvent/, '必须用包装器转发工具事件');
  // 打点必须带这个真实轮数（emitTurn 统一带 round: maxRound）。
  // ⚠️ FEAT-AC9 P0-2：这里原先钉的是**单对象形状**
  // `onTurnEvent({ event, round: maxRound, ... })` —— 那条断言正是把 BUG-E 的
  // 错误形状**锁死**的原因（发射方单对象 vs 接收方两参 ⇒ turn-unknown）。
  // 现在钉**两参契约**：event 名 + fields 对象。
  assert.match(turn, /onTurnEvent\(event, \{ round: maxRound, elapsed: Date\.now\(\) - startedAt, \.\.\.fields \}\)/,
    '打点必须走两参契约且带累积出的真实轮数');
  // 悬浮窗路径不得再硬编码 round: 0
  const overlayTurn = stripComments(read('src/screenWatch/overlayWorkspaceTurn.js'));
  assert.equal(/round: 0/.test(overlayTurn), false, '悬浮窗路径不得再硬编码 round: 0');
});

test('BUG-D：turn-done 只由 runWorkspaceWatchTurn 发（避免两条路径各发一次）', () => {
  // 打点收口在一处：悬浮窗路径不再自己发 turn-done（否则同一回合两条）
  const overlayTurn = stripComments(read('src/screenWatch/overlayWorkspaceTurn.js'));
  assert.equal(/noteTurnEvent\('turn-done'/.test(overlayTurn), false,
    '悬浮窗路径不得自己发 turn-done（已收口到 runWorkspaceWatchTurn）');
  // 异常路径仍要留痕。FEAT-AC9 P0-3：这条路径是**准备阶段失败**（取线程 / 读设置），
  // 从来不是超时——原先打 turn-timeout 会把「线程存储读失败」说成「模型没响应」。
  assert.match(overlayTurn, /noteTurnEvent\('turn-failed'/, '准备阶段失败要如实留痕（不是 timeout）');
  // 落库留痕的注入（两条路径都要）
  const panel = stripComments(read('src/workspace/screen/ScreenWatchPanel.js'));
  assert.match(panel, /onThreadAppend: info => noteTurnEvent\('thread-append', info\)/,
    '面板路径要注入落库留痕');
  assert.match(overlayTurn, /onThreadAppend: info => noteTurnEvent\('thread-append', info\)/,
    '悬浮窗路径要注入落库留痕');
});

// ---------- ⑥ FEAT-AC9 P1/P2 与行数棘轮 ----------

test('AC9 P1：主对话（「对话」tab）路径接入回合打点（此前完全隐形）', () => {
  // 证据（任务书 §三 P1）：真机 02:51「关闭语音播报」走主对话路径，
  // 日志里零 turn-* 痕迹（只有一行 [app-setting]）——用户最常用的路径在诊断日志里
  // 完全看不见，而它恰是 P1 七域工具（FEAT-AC6）的宿主。
  //
  // ⚠️ 对任务书的一处更正：它说这条路径经 `runHeadlessAgent 直连`。
  // 核实：**不是**——「对话」tab 是 ChatPanel.js，它**直接**调 runAgentTurn
  //（ChatPanel.js 的 `await runAgentTurn(request, {...})`），不经过 headlessAgent
  //（headlessAgent 是「看屏幕」工作区会话与本地 API 端点的执行器）。
  // 所以「在 headlessAgent 层收口」那条建议对本路径无效，必须接在 ChatPanel 的调用点。
  const panel = stripComments(read('src/workspace/screen/ChatPanel.js'));
  assert.match(panel, /\.\.\.turnEventHostOptions\(\)/,
    '主对话必须接入回合打点（P1：此前完全没有 onTurnEvent）');
  // 收口点写清楚（任务书要求「在提交说明里写清收口点」——代码里也留一行）
  const observation = read('src/workspace/screen/agentTurnObservation.js');
  assert.match(observation, /export function turnEventHostOptions\(\)/,
    '收口点：ChatPanel → agentTurnObservation.turnEventHostOptions → noteTurnEvent');
  assert.match(observation, /return \{ onTurnEvent: noteTurnEvent \};/,
    '收口点把 onTurnEvent 接成 noteTurnEvent（两参契约）');
  // thread-append 不得接进主对话：那是 screenWatch 线程专属（工作区对话走 chats.js）
  assert.equal(/thread-append/.test(stripComments(observation)), false,
    '主对话不得注入 thread-append（线程留痕是 screenWatch 专属，硬接会记出含义错误的行）');
});

test('AC9 P2-1：确认卡文案不再视觉嵌套（键移到问句之后）', () => {
  const text = summarizeToolCall({ name: 'set_app_setting', args: { key: 'tts.autoBroadcast', value: true } });
  // 键仍然要在（用户靠它回设置页核对）——只是不再紧贴描述的右括号
  assert.match(text, /tts\.autoBroadcast/, '键必须保留（是用户核对的把手）');
  assert.equal(text.includes('）」（'), false,
    `描述的右括号不得紧邻键的左括号（原事故形态）: ${text}`);
  // 描述自带括号时，键移到问句末尾
  assert.match(text, /允许吗？（tts\.autoBroadcast）/, `键应在问句之后: ${text}`);
  // 未知键（describeSetting 回落成键本身）→ 不再拼出「键（键）」
  const fallback = summarizeToolCall({ name: 'set_app_setting', args: { key: 'unknown.key', value: 1 } });
  assert.equal(fallback.includes('unknown.key（unknown.key）'), false,
    `未知键不得拼成「键（键）」: ${fallback}`);
});
test('AC9 P2-2：遗留空线程只滤显示、不删数据，且判据可直测', async () => {
  const {
    STALE_EMPTY_THREAD_MS,
    filterStaleEmptyThreads,
    isStaleEmptyThread,
  } = await import('../src/screenWatch/threadEntries.js');
  const now = Date.now();
  const old = { id: 't1', entries: [], updatedAt: now - STALE_EMPTY_THREAD_MS - 1000 };
  const fresh = { id: 't2', entries: [], updatedAt: now - 1000 };
  const hasContent = { id: 't3', entries: [{ id: 'e', text: '有内容' }], updatedAt: now - STALE_EMPTY_THREAD_MS - 1000 };
  assert.equal(isStaleEmptyThread(old, now), true, '旧的空线程 = 遗留');
  assert.equal(isStaleEmptyThread(fresh, now), false, '新的空线程不滤（可能还在用）');
  assert.equal(isStaleEmptyThread(hasContent, now), false, '有内容的一律不滤');
  assert.equal(isStaleEmptyThread(null, now), false, '空值不抛');
  assert.deepEqual(filterStaleEmptyThreads([old, fresh, hasContent], now).map(t => t.id), ['t2', 't3']);
  // 面板真的用了它（不是只定义）
  const panel = stripComments(read('src/workspace/screen/ScreenWatchPanel.js'));
  assert.match(panel, /setThreads\(filterStaleEmptyThreads\(/,
    '面板列表必须过遗留空线程过滤（否则 pre-AC7 的「（暂无内容）0」继续挂着）');
  // 「只滤显示不删数据」这条纪律的落点：**过滤模块自身不得碰存储**——
  // 判据（多久算遗留）会随产品调整，拿它做不可逆删除，改错判据就是数据损失。
  const entriesCode = stripComments(read('src/screenWatch/threadEntries.js'));
  for (const forbidden of ['deleteScreenWatchThread', 'clearScreenWatchThreads', 'removeItem']) {
    assert.equal(entriesCode.includes(forbidden), false,
      `展示层过滤不得删除数据（不得出现 ${forbidden}）`);
  }
  // 用户手动删除的入口仍在（面板自己那条），所以「滤掉」不等于「删不掉」
  assert.match(panel, /deleteScreenWatchThread\(item\.id\)/,
    '面板仍保留用户手动删除线程的入口');
});

test('行数：本轮新增/修改文件都在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'App.js',
    'src/agent/loop.js',
    'src/agent/tools/registry.js',
    'src/agent/tools/confirmBudget.js',
    'src/workspace/appSettingsSchema.js',
    'src/workspace/headlessAgent.js',
    'src/screenWatch/workspaceWatchTurn.js',
    'src/screenWatch/overlayWorkspaceTurn.js',
    'src/screenWatch/turnDiagnostics.js',
    'src/screenWatch/threadEvents.js',
    'src/screenWatch/threadEntries.js',
    'src/screenWatch/overlaySummary.js',
    'src/workspace/screen/ScreenWatchPanel.js',
    // FEAT-AC9 新增/外提文件
    'src/workspace/screen/agentTurnObservation.js',
  ]) {
    const lines = count(read(file));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
});
