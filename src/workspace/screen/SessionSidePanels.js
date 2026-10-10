// W2：会话侧栏面板的装配（回合小结 + 计划进度）。
//
// 为什么单独一个文件：这两块都是「贴着输入区、只在有内容时出现」的会话级面板，装配点
// 集中在这里，ChatPanel 的渲染里就只剩一行——它已经顶格，任何新增都该落在子模块里
// （行数棘轮是硬约束，这条不是风格偏好）。

import React from 'react';

import AgentPlanPanel from './AgentPlanPanel.js';
import TurnSummaryPanel from './TurnSummaryPanel.js';

export default function SessionSidePanels({
  characterId = 'default',
  messages = null,
  plan = [],
  canApprove = false,
  sending = false,
  onApprove = null,
}) {
  return (
    <>
      <TurnSummaryPanel characterId={characterId} messages={messages} />
      <AgentPlanPanel plan={plan} canApprove={canApprove} sending={sending} onApprove={onApprove} />
    </>
  );
}
