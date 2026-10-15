// 内置 MCP Server 的生产能力装配：真实设置、真实注册表、真实工具执行。
//
// 这个文件拖着重依赖（AsyncStorage / expo-file-system / 工作区沙箱），**只有 App 侧
// 才静态 import 它**；serverBridge.js 保持零重依赖（可 Node 直测），两者单向依赖。
//
// 工具执行这一段是本功能的**安全核心**，三个决定都写在这里，改之前请先读 serverPolicy 的
// 文件头（档位为什么这么分）与 registry.js 的 runTool（闸门为什么在那一层）：
//   1) mode 由档位派生：只读档 → read，写入/执行档 → write。不读工作区自己的 mode 设置
//      ——MCP 会话的授权是用户在 MCP 面板里点的那三档，与工作区面板的档位是两件事。
//   2) 工作区钩子（.easychat/hooks.json）的 before_tool 规则照旧喂进 permissionRules：
//      deny 必须对任意工具生效，不能因为「这次是外部 agent 发起的」就绕过用户的声明式策略。
//   3) confirm 只对「工具自己声明要确认」的工具放行（run_shell / run_python / git_discard /
//      install_extension_pack / run_remote_build），且必须先过 serverPolicy 的预览→confirm。
//      走到 confirm 的其它情形只可能是 hooks 的 ask 规则——那是「必须当场问用户」的语义，
//      MCP 会话里没有用户，按「问不到 = 拒绝」处理（与 taskRunner 同款纪律）。

import { getTool, listRegisteredTools, requiresConfirmationFor, runTool } from '../agent/tools/registry.js';
import { getMcpServerSettings, patchMcpServerSettings } from '../storage/settings.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { resolveWorkspaceAssistant } from '../workspace/assistant.js';
import { readHookPermissionRules } from '../workspace/hooks.js';
import { createWorkspaceStore, describeWorkspaceRoot, registerDefaultWorkspaceTools } from '../workspace/native.js';

import {
  attachMcpServer,
  createMcpBridge,
  getMcpServerStatus,
  startMcpServer,
  stopMcpServer,
} from './serverBridge.js';

export function readMcpServerSettings() {
  return getMcpServerSettings();
}

// 注册表是全局单例：这里只读它，不注册也不注销（注册由 executeMcpTool 与 UI 各自负责，
// 注销会波及 UI 正在用的同名工具——headlessAgent 的注释记过这个坑）。
export function listToolDefinitions() {
  return listRegisteredTools();
}

export async function describeMcpWorkspace() {
  try {
    const settings = await getWorkspaceSettings();
    const root = describeWorkspaceRoot(settings);
    return { kind: root.kind, root: root.name || root.uri, uri: root.uri };
  } catch (error) {
    return null;
  }
}

export async function executeMcpTool({ name, args, tier, characterId = '' }) {
  const settings = await getWorkspaceSettings();
  // 与工作区 agent / 无头端点同一套装配（store + shell + python + git + ci）。
  // 重复注册是幂等的；不传 onPlan = update_plan 不落盘（与无头端点一致）。
  registerDefaultWorkspaceTools(settings, {});
  const resolved = await resolveWorkspaceAssistant(characterId).catch(() => null);
  const ownerId = String((resolved && resolved.character && resolved.character.id) || characterId || '');
  const store = createWorkspaceStore(settings);
  const mode = tier === 'read' ? 'read' : 'write';
  return runTool({ name, arguments: args }, {
    mode,
    characterId: ownerId,
    permissionRules: () => readHookPermissionRules(store, ownerId),
    confirm: async ({ name: toolName, args: toolArgs }) => {
      const definition = getTool(toolName);
      // ⚠️ 必须走 requiresConfirmationFor，不能写 `definition.requiresConfirmation === true`：
      // 后者对**函数形态**（control_music 的按 action 分级）求值为 false ——
      // 那是放行方向（fail-open）。MCP 的语义是「工具自己声明要确认 ⇒ 档位+预览已替用户
      // 回答」，所以这里必须认得出函数形态，否则 control_music 在 MCP 写档下会不经确认执行。
      return requiresConfirmationFor(definition, toolArgs || {});
    },
  });
}

export function createRuntimeMcpBridge() {
  return createMcpBridge({
    readSettings: readMcpServerSettings,
    listDefinitions: listToolDefinitions,
    executeTool: executeMcpTool,
    workspaceInfo: describeMcpWorkspace,
  });
}

// App 启动时接一次：把原生事件接到协议层。**与服务器是否启用无关**——事件订阅只是
// 「有请求时能应答」，启不启用由 syncMcpServer 决定（没启用时原生根本不监听端口）。
export function attachRuntimeMcpServer() {
  return attachMcpServer({ bridge: createRuntimeMcpBridge() });
}

// 按当前设置启停原生服务，并把原生生成的 token 回写持久化。
// 幂等：App 启动、用户改设置、用户开关都调它。
export async function syncMcpServer() {
  const settings = await getMcpServerSettings();
  if (!settings.enabled) {
    await stopMcpServer().catch(() => {});
    return { settings, status: await getMcpServerStatus(), error: '' };
  }
  // 范围：仅本机 → 绑回环；局域网 → 绑 0.0.0.0（由原生枚举网卡给对外地址）。
  const host = settings.scope === 'lan' ? '0.0.0.0' : '127.0.0.1';
  try {
    const started = await startMcpServer({ host, port: settings.port, token: settings.mcpToken });
    let next = settings;
    if (started.mcpToken && started.mcpToken !== settings.mcpToken) {
      // 空 token 由原生生成：必须回写，否则下次启动又生成一个，用户已复制给 agent 的配置当场失效。
      next = await patchMcpServerSettings({ mcpToken: started.mcpToken }).catch(() => settings);
    }
    return { settings: next, status: await getMcpServerStatus(), error: '' };
  } catch (error) {
    // 起不来就别假装开着：回滚开关，把原因交给界面（端口被占是最常见的形态——
    // 端口已被另一个 App 或上一次没退干净的实例占着）。留着「已启用」而服务没跑，
    // 用户会以为连不上是 agent 的问题。
    const rolled = await patchMcpServerSettings({ enabled: false }).catch(() => settings);
    return {
      settings: rolled,
      status: await getMcpServerStatus(),
      error: String((error && error.message) || error || ''),
    };
  }
}
