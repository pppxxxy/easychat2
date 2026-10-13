// W2：会话侧栏面板的装配（回合小结 + 计划进度 + AS2 确认卡组）。
//
// 为什么单独一个文件：这几块都是「贴着输入区、只在有内容时出现」的会话级面板，装配点
// 集中在这里，ChatPanel 的渲染里就只剩一行——它已经顶格，任何新增都该落在子模块里
// （行数棘轮是硬约束，这条不是风格偏好）。
//
// ConfirmFlow 卡组（AS2）在这里订阅 confirmFlowBridge：agent 循环里的 confirm_flow
// 工具挂起等待时，桥上有待确认快照 → 卡组出现在对话流内（ConfirmBar 同款「问什么
// 留在它问的那件事旁边」）；提交/取消把答案回给工具。

import React, { useSyncExternalStore } from 'react';

import AgentPlanPanel from './AgentPlanPanel.js';
import ConfirmFlowSheet from './ConfirmFlowSheet.js';
import TurnSummaryPanel from './TurnSummaryPanel.js';
import {
  cancelConfirmFlow,
  getPendingConfirmFlow,
  respondConfirmFlow,
  subscribeConfirmFlow,
} from './confirmFlowBridge.js';

export default function SessionSidePanels({
  characterId = 'default',
  messages = null,
  plan = [],
  canApprove = false,
  sending = false,
  onApprove = null,
}) {
  const pendingConfirm = useSyncExternalStore(subscribeConfirmFlow, getPendingConfirmFlow);
  return (
    <>
      <TurnSummaryPanel characterId={characterId} messages={messages} sending={sending} />
      <AgentPlanPanel plan={plan} canApprove={canApprove} sending={sending} onApprove={onApprove} />
      {pendingConfirm ? (
        <ConfirmFlowSheet
          questions={pendingConfirm.questions}
          onSubmit={answers => respondConfirmFlow(answers)}
          onCancel={cancelConfirmFlow}
        />
      ) : null}
    </>
  );
}
