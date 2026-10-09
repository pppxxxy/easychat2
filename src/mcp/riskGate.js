// MCP 工具风险分级（纯判定，Node 直测）。
//
// 用户裁决（2026-10-05，最高优先级约束）：
//   - 低风险行为（拉取/提交/推送之类）可用：只读直接放行，写入类逐条人工确认；
//   - 高风险行为**无条件禁止**：删除分支、删除文件、强推、管理类操作……
//     **即使用户同意、强烈要求也不可解锁**——没有开关，没有确认弹框，没有例外。
//
// 分级**分域**（2026-10-09 通用 MCP，spec: agent-extensibility T1）：
//   1) FORBIDDEN_NAME_PATTERN（delete/remove/force/admin）**全局**硬禁，跨服务器
//      无解锁途径——安全不回退；
//   2) 内置 GitHub（serverId='github'，默认）：沿用白名单。实现取**白名单**而不是
//      黑名单——服务端工具集持续演进，新增高危工具不该因「名单没收录」漏进注册表，
//      非名单一律 denied（现有行为不变）；
//   3) 第三方服务器（用户自己配置、工具集未知）：**默认 CONFIRM**（注册但每次调用
//      逐条确认），可按服务器用 tierOverrides 调级（readonly 放行 / denied 禁用）。
//      比「一律 denied」可用（否则第三方全不可用），比「静默放行只读」安全。
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

export function classifyMcpTool(name, { serverId = 'github', tierOverrides = null } = {}) {
  const normalized = String(name || '').trim();
  if (!normalized) return MCP_TOOL_TIERS.DENIED;
  // ① 硬禁全局：跨服务器都无解锁途径（即使用户同意）。
  if (FORBIDDEN_NAME_PATTERN.test(normalized)) return MCP_TOOL_TIERS.DENIED;
  // ② 内置 GitHub：现有白名单语义原样（**不传第二参**时靠上面的默认值回到本分支）。
  // 2026-10-09（审查报告 BUG-2 的同类硬化）：这里原先还接受空 serverId（`!serverId`），
  // 于是「id 丢失/为空的服务器」会静默拿到内置白名单语义——恰好叫 search_code 的第三方
  // 工具会被判只读、免确认放行。空 id 的第三方记录到不了这里（normalizeMcpServer 对空 id
  // 直接判废），所以这是**潜在**风险而非活 bug；但白名单是这套系统的信任根基，
  // 宁可让空值落到第三方默认（CONFIRM 逐条确认）——失败方向是「多问一次」而不是「少问一次」。
  if (serverId === 'github') {
    // 内置 GitHub **刻意不支持 tierOverrides 调级**（传了也不读）：三档白名单是
    // 精心划定的安全语义，允许用户调级会让「确定性」依赖配置正确性。第三方服务器
    // 才需要调级——它们的工具集未知，本来就没有白名单可言。这条差异是**有意决定**，
    // 不是漏实现（测试钉死；报告质量建议 ④）。
    if (READONLY_TOOLS.has(normalized)) return MCP_TOOL_TIERS.READONLY;
    if (CONFIRM_TOOLS.has(normalized)) return MCP_TOOL_TIERS.CONFIRM;
    return MCP_TOOL_TIERS.DENIED;
  }
  // ③ 第三方服务器：默认 CONFIRM，tierOverrides 可按工具调级。
  const override = tierOverrides && typeof tierOverrides === 'object' ? tierOverrides[normalized] : '';
  if (override === MCP_TOOL_TIERS.READONLY) return MCP_TOOL_TIERS.READONLY;
  if (override === MCP_TOOL_TIERS.DENIED) return MCP_TOOL_TIERS.DENIED;
  return MCP_TOOL_TIERS.CONFIRM;
}

export function isMcpToolExecutable(name, options = {}) {
  return classifyMcpTool(name, options) !== MCP_TOOL_TIERS.DENIED;
}

// 把服务端 tools/list 的原始目录过滤成可注册的 agent 工具。
// 返回 allowed（带分级）与 deniedNames（调试/走查用，不进模型上下文）。
export function filterMcpToolsForRegistration(tools, options = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const allowed = [];
  const deniedNames = [];
  for (const tool of list) {
    const name = tool && typeof tool === 'object' ? String(tool.name || '').trim() : '';
    if (!name) continue;
    const tier = classifyMcpTool(name, options);
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
