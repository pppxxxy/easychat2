// 工具结果里的「提示类」文案（run_subagent / run_workflow / git_* 共用）。
//
// 为什么单独一个模块：这几句的受众**既是模型也是用户**——
//   · 模型：工具结果就是它的下一步依据，必须能读到「为什么没执行、谁该做什么」；
//   · 用户：工作区工具行（workspace/conversation.js 的 toolRowsFromTrace →
//     screen/ToolCallRow.js）把 `result.content` 直接当「结果预览 / 完整输出」显示，
//     英文界面下会读到中文。
// 两个受众的处理方式不同，照仓库既有范式拆成两侧：
//   · templates.js:12 —— 正文（项目文件内容）留中文，名/描述走词条；
//   · extension/schedule/preview.js:4 —— prompt 不进 i18n，界面预览走 t()。
//
// ⇒ **模型侧**：下面的中文常量。**不得翻译**——翻译会改变模型读到的内容（仓库铁律），
//    而且 tests/readModeEscalation.test.mjs 把「只读模式」钉在 result.content 上，
//    改字既动模型行为又破门禁。
// ⇒ **界面侧**：NOTICE_KEYS 里的词条（zh-CN / en 各一条）。工具结果额外带上
//    noticeKey / noticeParams，展示层取到后用 t() 渲染即可，不再依赖中文正文。
//    展示层的接线不在本批文件所有权内，见交付说明。
//
// 本模块**零依赖**（不 import 任何东西），所以不会给 toolDefs 引入循环依赖——
// gitTools.js / subagentTool.js / workflowTool.js 都能安全引用它。
//
// 关于第三个变体（workflowRunner.js 的 `'当前不是「可改」模式，write 步骤未执行'`）：
// 它形状不同（只陈述「模式不对 + 没执行」，**不含**给用户的操作指示），且它是
// **步骤级**错误——上抛给编排层后由 run_workflow 工具层自己的整条拒绝文案负责把
// 「请用户切模式」讲清楚。两处硬凑成一句会让步骤级错误变成半截用户指示，故**有意不统一**；
// 它唯一的重复点是「只读模式」这个概念的说法，而两种说法本来就不一样
//（「当前是只读模式」 vs 「当前不是「可改」模式」），强行合并等于改模型读到的字。

// ---- 模型侧（中文，不得翻译）----

// 「谁该做什么」的那半句：run_subagent 与 run_workflow 的拒绝文案**逐字共用**它。
// 抽出来是为了结构上不可能漂移（此前两处各写一遍，改一处忘另一处就会让模型
// 在两个工具上读到不同的下一步指示）。
export const MODE_SWITCH_HINT = '写操作需要用户切到「可改」模式（未执行）。';

// 「为什么没执行」的那半句。注意两处措辞一致（都是「当前是只读模式」），
// 与 workflowRunner 的「当前不是「可改」模式」是两种说法，见文件头说明。
export const READ_ONLY_CLAUSE = '当前是只读模式，';

export const GIT_NO_REPO_TEXT = '本地版本控制还没就绪：这个工作区还没有 git 仓库。请在「工作区 → 设置」里打开「本地版本控制」开关（会初始化仓库），然后再试。';

export const SUBAGENT_WRITE_BLOCKED_TEXT = `写子代理不可用：${READ_ONLY_CLAUSE}${MODE_SWITCH_HINT}`;

// 工作流整条拒绝：点名要求 write 的步骤，再复用同一句用户指示。
export function workflowWriteBlockedText(stepIds) {
  const ids = Array.isArray(stepIds) ? stepIds.join('、') : String(stepIds == null ? '' : stepIds);
  return `工作流无法执行：步骤 ${ids} 要求 write 模式，但${READ_ONLY_CLAUSE}${MODE_SWITCH_HINT}`;
}

// ---- 界面侧（i18n 词条 key，展示层 t(key) 取当前语言）----

// key 一律导出，让 `scripts/find_missing_i18n_keys.js` 与人工 review 都能顺着
// 「工具结果 → 词条」这条线找到语言包里的对应值（中文正文里搜不到英文用户看到的东西）。
export const TOOL_NOTICE_KEYS = Object.freeze({
  gitNoRepo: 'workspace.chat.tool.notice.gitNoRepo',
  subagentWriteBlocked: 'workspace.chat.tool.notice.subagentWriteBlocked',
  workflowWriteBlocked: 'workspace.chat.tool.notice.workflowWriteBlocked',
});

// 工具结果 → 界面侧提示。返回的对象是**附加字段**（content 仍是模型侧中文），
// 展示层只要读 noticeKey 就能用当前语言渲染，不需要做「中文正文 → key」的匹配
//（那种匹配在模型换句话时就悄悄失效了）。
//
// 参数：params 只放语言相关的变量（如步骤名），中文正文里的变量与它同源。
export function noticeFields(noticeKey, params) {
  return params ? { noticeKey, noticeParams: params } : { noticeKey };
}
