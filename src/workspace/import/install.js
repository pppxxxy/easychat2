// 把适配出的资产写进本应用的各处存储。
//
// 写入分工（沿用仓库既有边界，不新开旁路）：
//   skills / commands / agents → 工作区文件（store.writeWorkspaceFile）
//   packs                      → packs.js 的 installWorkspacePack（同一套允许清单与限额）
//   plugins                    → plugins/loader.js 的 installPlugin（.easychat/plugins.json）
//   MCP 服务                   → 由调用方注入的 mcp.load/save（存储层负责归一化与钥匙串）
//
// **插件安装的开关是刻意留的**：paths.js 明确写着「用户仍可在面板/UI 里装插件；这里只挡
// agent 的写工具」——插件 handler 是代码执行，所以 agent 工具必须 allowPlugins:false，
// 只把「发现了插件」报给用户，由用户在界面上确认安装。UI 侧走 allowPlugins:true。
//
// 纯逻辑 + 注入 store/mcp，Node 直测。

import { installPlugin } from '../plugins/loader.js';
import { installWorkspacePack } from '../packs.js';

// 列表内按 id 覆盖或追加。只做合并，不做校验——归一化由存储层（saveMcpServers）负责，
// 避免这里再抄一份 normalizeMcpServer 的规则出来漂移。
export function mergeMcpServer(list, server) {
  const current = Array.isArray(list) ? list : [];
  const id = String((server && server.id) || '').trim();
  if (!id) return current;
  const index = current.findIndex(item => String((item && item.id) || '').toLowerCase() === id.toLowerCase());
  if (index === -1) return [...current, server];
  const next = [...current];
  next[index] = { ...current[index], ...server };
  return next;
}

function emptySummary() {
  return {
    ok: false,
    installed: { plugins: 0, packs: 0, skills: 0, commands: 0, agents: 0, mcpServers: 0 },
    skipped: [],
    errors: [],
  };
}

// artifacts: detectArtifacts 的输出。mcp: { load, save }（可选；缺省则跳过 MCP 资产）。
export async function installArtifacts({
  store,
  characterId,
  artifacts,
  mcp = null,
  allowPlugins = true,
  overwrite = true,
} = {}) {
  const summary = emptySummary();
  const source = artifacts && typeof artifacts === 'object' ? artifacts : {};
  if (!store || typeof store.writeWorkspaceFile !== 'function') {
    summary.errors.push({ kind: 'store', name: '', error: 'workspaceStoreUnavailable' });
    return summary;
  }

  // 技能 / 命令 / 子代理：三者的写入方式完全一致（都是工作区里的 markdown 文件）
  for (const [kind, list] of [['skills', source.skills], ['commands', source.commands], ['agents', source.agents]]) {
    for (const item of Array.isArray(list) ? list : []) {
      try {
        await store.writeWorkspaceFile({ characterId, path: item.path, content: item.content });
        summary.installed[kind] += 1;
      } catch (error) {
        summary.errors.push({ kind, name: item.name || item.path, error: String((error && error.message) || error) });
      }
    }
  }

  // 扩展包：走既有实现（它自己带允许清单、路径越界检查与限额）
  for (const item of Array.isArray(source.packs) ? source.packs : []) {
    try {
      const result = await installWorkspacePack(store, characterId, item.pack, { overwrite });
      summary.installed.packs += 1;
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        summary.errors.push({ kind: 'pack', name: item.name || '', error: result.errors.join(', ') });
      }
    } catch (error) {
      summary.errors.push({ kind: 'pack', name: item.name || '', error: String((error && error.message) || error) });
    }
  }

  // 插件：代码执行资产，agent 工具不得安装（见文件头）
  for (const item of Array.isArray(source.plugins) ? source.plugins : []) {
    if (!allowPlugins) {
      summary.skipped.push({ kind: 'plugin', name: item.name || item.id, reason: 'pluginNeedsUserInstall' });
      continue;
    }
    try {
      const result = await installPlugin({ store, characterId, manifest: item.manifest });
      if (result && result.ok === false) {
        summary.errors.push({ kind: 'plugin', name: item.name || item.id, error: String(result.error || '') });
      } else {
        summary.installed.plugins += 1;
      }
    } catch (error) {
      summary.errors.push({ kind: 'plugin', name: item.name || item.id, error: String((error && error.message) || error) });
    }
  }

  // MCP 服务：一次读-合并-写（逐个 save 会互相覆盖）
  const servers = Array.isArray(source.mcpServers) ? source.mcpServers : [];
  if (servers.length > 0) {
    if (!mcp || typeof mcp.load !== 'function' || typeof mcp.save !== 'function') {
      servers.forEach(item => summary.skipped.push({ kind: 'mcpServer', name: item.name, reason: 'mcpUnavailable' }));
    } else {
      try {
        let list = await mcp.load();
        for (const item of servers) {
          list = mergeMcpServer(list, item);
          summary.installed.mcpServers += 1;
        }
        await mcp.save(list);
      } catch (error) {
        summary.installed.mcpServers = 0;
        summary.errors.push({ kind: 'mcpServer', name: '', error: String((error && error.message) || error) });
      }
    }
  }

  summary.ok = summary.errors.length === 0;
  return summary;
}

export function summarizeInstall(summary) {
  const source = summary && typeof summary === 'object' ? summary : {};
  const installed = source.installed && typeof source.installed === 'object' ? source.installed : {};
  const total = Object.values(installed).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return {
    total,
    installed,
    skipped: Array.isArray(source.skipped) ? source.skipped.length : 0,
    errors: Array.isArray(source.errors) ? source.errors.length : 0,
  };
}
