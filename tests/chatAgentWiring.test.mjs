// 聊天 ↔ agent 工具循环接线的源码断言（RN/流式依赖运行时，Node 进不去）。
// 关键回归钉：
// - ask 模式：不注册工具、不触达 runAgentTurn，仍走原 sendChatMessage 路径（零变化）；
// - read/write：onlineSend 走 runAgentTurn，mode/tools/signal/context 齐全；
// - 配置守卫经 requestOptions 透传（expectedConfigId/Fingerprint），不再外露给 api；
// - 工具状态气泡是 pending+transient（临时、不落库），并在中止/成功/异常三个出口清理。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');

test('接线导入与 mode 读取', () => {
  assert.ok(source.includes("from '../agent/tools/registry.js'"), '导入工具注册表');
  assert.ok(source.includes('listToolsForMode'), '按模式派生工具集');
  assert.ok(source.includes("from '../agent/loop.js'"), '导入 runAgentTurn');
  assert.ok(source.includes("from '../workspace/native.js'"), '导入默认工作区工具注册');
  assert.ok(source.includes('getWorkspaceSettings'), '读工作区模式');
  assert.ok(/let workspaceMode = 'ask'/.test(source), '模式默认 ask（读失败也不改变发送行为）');
});

test('ask 零变化：不注册工具、走 sendChatMessage；read/write 走 runAgentTurn', () => {
  assert.ok(source.includes("if (workspaceMode !== 'ask')"), '仅非 ask 才注册/派生工作区工具');
  // 必须把当前工作区设置一并传入：后端（应用内 / 外部文件夹）由设置决定，
  // 不传等于永远走应用私有根，用户选的文件夹会被静默忽略。
  // O0.3：额外注入 onPlan（update_plan 的清单随会话落盘）。
  assert.ok(source.includes('registerDefaultWorkspaceTools(workspaceSettings,'), '注册默认工作区工具并带上设置');
  assert.ok(source.includes('onPlan: steps => saveSessionPlan(sendSessionId, steps)'), 'O0.3：计划随会话落盘');
  assert.ok(/agentTools\.length > 0[\s\S]{0,80}runAgentTurn/.test(source), '有工具才走循环');
  assert.ok(source.includes('sendChatMessage(onlineMessages'), '无工具时仍是 sendChatMessage');
  // 工具集按模式派生，并带上聊天内工具的放行开关（默认关闭 → 与旧行为一致）。
  assert.ok(/listToolsForMode\(\s*workspaceMode,\s*\{ allowChatTools: chatToolsEnabled \}\s*\)/.test(source),
    '工具集按当前模式派生，并透传聊天内工具开关');
  assert.ok(/let chatToolsEnabled = false;/.test(source), '聊天内工具默认关闭（缺省不改变发送行为）');
});

// 新增语义（与上面那条并存）：聊天内工具是**独立开关**，开启后即使工作在 ask 模式
// 也要走 runAgentTurn——否则聊天页（默认 ask）永远用不上它。
test('聊天内工具开启后 ask 模式也走 runAgentTurn（独立于工作区门控）', () => {
  assert.ok(source.includes('registerChatTools()'), '开启时注册聊天内工具');
  assert.ok(source.includes('unregisterChatTools()'), '关闭时必须真摘掉注册（不是仅不勾选）');
  assert.ok(/chatOptionsForTools\.chatTools === true/.test(source), '读数来自 chatOptions');
});

test('runAgentTurn 调用参数齐全 + 守卫透传', () => {
  const idx = source.indexOf('runAgentTurn(onlineMessages');
  assert.ok(idx >= 0, '存在 runAgentTurn 调用');
  // 窗口要盖住整个调用（T6 起 onToolApproval 是带钩子注入的 async 块，比原先长；
  // P1/K1 又加了 contextBudgetBytes；整合后 M 系又添了几项，取两线中较大的窗口）。
  const block = source.slice(idx, idx + 4400);
  assert.ok(/mode:\s*workspaceMode/.test(block), '传 mode');
  assert.ok(/tools:\s*agentTools/.test(block), '传 tools');
  assert.ok(/signal:\s*controller\.signal/.test(block), '传取消信号');
  assert.ok(/requestOptions:\s*\{[\s\S]*expectedConfigId/.test(block), '守卫经 requestOptions 透传');
  assert.ok(block.includes('expectedConfigFingerprint'), '指纹守卫也在 requestOptions');
  assert.ok(/onToken:/.test(block) && /onReasoning:/.test(block) && /onToolEvent:/.test(block),
    '三条 UI 回调齐全');
  assert.ok(/context:\s*\{[\s\S]*characterId[\s\S]*sessionId/.test(block), '工具沙盒上下文');
  assert.ok(/allowChatTools:\s*chatToolsEnabled/.test(block),
    '开关要传到 loop：只放行暴露层、执行层仍按工作区拒绝，会表现为「模型调了但总失败」');
  // P1/K1：不接通预算 = K1 永不触发（默认 2MB 是请求上下文到不了的量）。
  assert.ok(/contextBudgetBytes:\s*k1ContextBudgetBytes/.test(block),
    'K1 的字符预算必须按模型窗口接通（实测不接通时清除 0 条）');
  assert.ok(/resolveAgentContextBudget\(onlineMessages,\s*online\.contextWindow\)/.test(source),
    '预算来自模型声明的窗口（未声明时为 0 → 不传 → 保持旧行为）');
});

test('接线：所有流式回调（onToken / onChunk / onReasoning）都必须走节流器', () => {
  // 失效模式（2026-10-17 实查发现三条）：onToken/onChunk 直连 setMessages —— 每个 token
  // 一次整表重渲。在线路径与群聊逐角色路径早就接了节流器，但 **agent 工具循环**、
  // **本地模型**（chunk 密度比在线流还高）与**群聊合议**（还额外做 O(N) 整表 map）三条
  // 漏在外面。这里按「每个回调到下一个回调之间必须出现 Throttle.push(」来钉，新增回调
  // 若忘了接节流器就会红。
  const handlers = [...source.matchAll(/on(Token|Chunk|Reasoning):\s*[A-Za-z_$][\w$]*\s*=>\s*\{/g)];
  assert.ok(handlers.length >= 5, `应找到多条流式回调（在线/本地/agent/合议 × 正文与思考），实际 ${handlers.length}`);
  const offenders = [];
  handlers.forEach((match, index) => {
    const end = index + 1 < handlers.length ? handlers[index + 1].index : source.length;
    const body = source.slice(match.index, end);
    if (!/Throttle\.push\(/.test(body)) offenders.push(`on${match[1]}@${match.index}`);
  });
  assert.deepEqual(
    offenders,
    [],
    `这些流式回调仍在直连 setMessages（每个 token 一次整表重渲）：${offenders.join(', ')}`
  );
});

// 审批钩子漏接 = 需要确认的工具全部跑不了（registry 的无 confirm 即拒绝）。
// 漏接时的表现是「模型一直说命令被拒绝」，界面不报错，很难查——所以把接线钉死。
test('runAgentTurn 接了 onToolApproval + permissionRules，并把中止信号一并传下去', () => {
  const idx = source.indexOf('runAgentTurn(onlineMessages');
  const block = source.slice(idx, idx + 4400);
  const hookAt = block.indexOf('onToolApproval:');
  const hookBlock = block.slice(hookAt, hookAt + 1400);
  // T3 起审批走 approveToolCall：先查已记住的规则（本次会话 / 永远允许），
  // 未命中才弹三选项框——直接调 requestToolApproval 会绕过规则，等于授权不生效。
  assert.ok(/onToolApproval:\s*call =>/.test(hookBlock), '审批钩子接上 approveToolCall');
  assert.ok(/approveToolCall\(/.test(hookBlock), '必须接上完整流转（规则 → 弹框）');
  assert.ok(/signal:\s*controller\.signal/.test(hookBlock),
    '审批要拿到中止信号：用户点停止时不留悬挂弹框');
  // P1（2026-10-11）+ P0-2（2026-10-12）：规则**不走审批**——审批只在需要确认的工具上
  // 被调用，写工具按设计不逐条确认，只接审批等于规则永不生效。它们由 permissionRules
  // 一路喂给 registry.runTool（对任意工具求值）。
  // ⚠️ 两线各自独立修了「只接钩子规则 ⇒ 面板手写 deny 对写工具是死键」；
  // 合并后**取 D 线形态**：走 readToolPermissionRules（钩子规则 + 用户存储规则合并，
  // 合并点在 toolApprovalFlow —— hooks.js 保持存储无关，否则纯 Node 用例会被 expo 依赖打挂）。
  // 断言因此同时钉住「必须合并」与「不得退回只接钩子规则」。
  assert.ok(/permissionRules:\s*async\s*\(\)\s*=>\s*readToolPermissionRules\(/.test(block),
    '钩子 + 存储规则要合并后接进 runTool（否则写工具上的手写 deny 永不生效）');
  assert.ok(!/permissionRules:\s*async\s*\(\)\s*=>\s*\[/.test(block),
    '不得退回「两边各读一份、在调用点拼数组」的旧形态（合并点应收在 toolApprovalFlow）');
  assert.ok(/t:\s*tRef\.current/.test(block), '审批文案走 tRef（跟当前语言，不用闭包旧 t）');
});

test('审批钩子无硬编码中文（注释除外）', () => {
  const start = source.indexOf('onToolApproval:');
  const block = source.slice(start, start + 700);
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = block.split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .map(line => line.replace(/\/\/.*$/, ''))
    .filter(line => CJK.test(line));
  assert.deepEqual(offenders, [], `onToolApproval 回调仍含硬编码中文：\n${offenders.join('\n')}`);
});

// 气泡形态已从「一段文字、end 时清掉」升级为「可见的结构化气泡」（见
// tests/chatTools.test.mjs 的展示逻辑断言）。2026-10 起气泡消息的构造点与
// 状态变换挪到 chat/toolBubbleView.js 的 updateToolBubbles（隐藏开关也走它，
// 行为验证见 tests/toolBubbleVisibility.test.mjs），这里仍只钉两条不变的属性：
// 临时不落库、三个出口清理。
test('工具气泡：临时不落库 + 三个出口清理', () => {
  const view = fs.readFileSync(path.resolve('src/chat/toolBubbleView.js'), 'utf8');
  assert.ok(view.includes('TOOL_BUBBLE_KIND'), '工具气泡有独立 kind');
  assert.ok(/kind: TOOL_BUBBLE_KIND,[\s\S]{0,300}transient: true/.test(view),
    '工具气泡标记 transient（落库过滤会剔除）');
  assert.ok(source.includes('toolBubbleState(event)'), '事件经统一映射（start→running / end→done|error）');
  assert.ok(source.includes('setToolBubble('), 'end/收尾更新气泡状态');
  const clears = (source.match(/clearToolBubble\(\)/g) || []).length;
  assert.ok(clears >= 3, `至少三处清理（中止/成功/异常），实际 ${clears}`);
});

// 气泡文案必须走 i18n：只断言词条存在是不够的，调用点换回硬编码中文时词条断言
// 全绿（词条仍在 locales 里），注入验证实测漏过——这里把调用点钉死。
// 展示映射在 chat/toolBubbleView.js（纯函数，产出 i18n key），组件再 t() 一次。
test('工具气泡文案：映射走 i18n key，不在组件里硬编码中文', () => {
  const component = fs.readFileSync(path.resolve('src/chat/ToolBubble.js'), 'utf8');
  const mapping = fs.readFileSync(path.resolve('src/chat/toolBubbleView.js'), 'utf8');

  assert.ok(component.includes("from './toolBubbleView.js'"), '组件消费纯映射模块');
  assert.ok(/t\(view\.nameKey,\s*view\.nameParams\)/.test(component), '工具名走 t()');
  assert.ok(/t\(view\.statusKey\)/.test(component), '状态文案走 t()');
  assert.ok(mapping.includes('chat.toolBubble.name.'), '映射模块产出 i18n key 前缀');
  assert.ok(mapping.includes('chat.toolBubble.status.'), '状态 key 前缀也在映射模块');

  // 组件与映射模块都不得含硬编码中文（注释除外）
  for (const [label, text] of [['ToolBubble.js', component], ['toolBubbleView.js', mapping]]) {
    const CJK = /[\u4e00-\u9fff]/;
    const offenders = text.split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .map(line => line.replace(/\/\/.*$/, ''))
      .filter(line => CJK.test(line));
    assert.deepEqual(offenders, [], `${label} 仍含硬编码中文：\n${offenders.join('\n')}`);
  }

  // 气泡数据由 onToolEvent 驱动——send 侧回调体内不得残留硬编码中文
  const start = source.indexOf('onToolEvent:');
  assert.ok(start >= 0, '存在 onToolEvent');
  const block = source.slice(start, start + 900);
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = block.split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .map(line => line.replace(/\/\/.*$/, ''))
    .filter(line => CJK.test(line));
  assert.deepEqual(offenders, [], `onToolEvent 回调仍含硬编码中文：\n${offenders.join('\n')}`);
});
