// AS2：confirm_flow 多题确认卡组的词条（从 workspace 域拆出独立文件——
// workspace.js 已顶到行数棘轮上限，词条域文件是既定的扩容路径）。
export const confirmFlow = {
  'workspace.confirmFlow.yes': '是',
  'workspace.confirmFlow.no': '否',
  'workspace.confirmFlow.other': '其他',
  'workspace.confirmFlow.customChosen': '其他（已填）',
  'workspace.confirmFlow.submit': '提交确认',
  'workspace.confirmFlow.freePlaceholder': '输入你的想法…',
  'workspace.confirmFlow.editPlaceholder': '改一改，或直接用预填内容…',
  'workspace.confirmFlow.missing': '还有 {count} 题没作答',
};

export default confirmFlow;
