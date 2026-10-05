// GitHub MCP 工具风险分级（纯判定，Node 直测）。
//
// 用户裁决（2026-10-05，最高优先级约束）：
//   - 低风险行为（拉取/提交/推送之类）可用：只读直接放行，写入类逐条人工确认；
//   - 高风险行为**无条件禁止**：删除分支、删除文件、强推、管理类操作……
//     **即使用户同意、强烈要求也不可解锁**——没有开关，没有确认弹框，没有例外。
//
// 实现取**白名单**而不是黑名单：GitHub MCP 服务端的工具集会持续演进，
// 新增的高危工具不该因为「名单还没收录」而漏进注册表。分级默认值是 denied。
// 双保险：这里只决定「注册不注册」，执行层（mcpTools.js）在每次 tools/call
// 前还会重查一遍——就算注册表被别处塞进脏工具，执行也进不去。

export const MCP_TOOL_TIERS = Object.freeze({
  READONLY: 'readonly',  // 只读：直接允许（read/write 模式按注册表门控）
  CONFIRM: 'confirm',    // 变更：允许注册，但每次调用需用户逐条点头
  DENIED: 'denied',      // 禁止：不注册、不可执行，无任何解锁途径
});

// 只读白名单：查询类，不改变任何远端状态。
const READONLY_TOOLS = new Set([
  'get_me',
  'get_file_contents',
  'list_branches',
  'list_commits',
  'list_issues',
  'list_pull_requests',
  'search_repositories',
  'search_code',
]);

// 写入白名单：会改动远端，但都属于「提交/推送/开分支/发评论」这类用户点名的
// 低风险动作。执行时必须经逐条确认（requiresConfirmation）。
const CONFIRM_TOOLS = new Set([
  'create_branch',
  'create_or_update_file',
  'push_files',
  'create_pull_request',
  'create_issue',
  'add_issue_comment',
]);

// 硬禁止形态：名字命中即拒绝，优先级高于上面两张白名单。
// delete_/remove_（删分支、删文件、删仓库…）、force_（强推）、admin/管理类。
const FORBIDDEN_NAME_PATTERN = /(^|_)(delete|remove|force|admin)(_|$)/i;

export function classifyMcpTool(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return MCP_TOOL_TIERS.DENIED;
  if (FORBIDDEN_NAME_PATTERN.test(normalized)) return MCP_TOOL_TIERS.DENIED;
  if (READONLY_TOOLS.has(normalized)) return MCP_TOOL_TIERS.READONLY;
  if (CONFIRM_TOOLS.has(normalized)) return MCP_TOOL_TIERS.CONFIRM;
  return MCP_TOOL_TIERS.DENIED;
}

export function isMcpToolExecutable(name) {
  return classifyMcpTool(name) !== MCP_TOOL_TIERS.DENIED;
}

// 把服务端 tools/list 的原始目录过滤成可注册的 agent 工具。
// 返回 allowed（带分级）与 deniedNames（调试/走查用，不进模型上下文）。
export function filterMcpToolsForRegistration(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const allowed = [];
  const deniedNames = [];
  for (const tool of list) {
    const name = tool && typeof tool === 'object' ? String(tool.name || '').trim() : '';
    if (!name) continue;
    const tier = classifyMcpTool(name);
    if (tier === MCP_TOOL_TIERS.DENIED) {
      deniedNames.push(name);
      continue;
    }
    const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
    allowed.push({
      name,
      description: String(tool.description || ''),
      parameters,
      tier,
    });
  }
  return { allowed, deniedNames };
}
