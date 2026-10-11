// 插件市场（内置目录）——差距 #2「市场」的可行切面。
//
// 真正的市场需要服务端与签名分发；移动端离线优先的可行形态是**内置精选目录**：仓库里
// 打包若干可一键安装的插件（清单 + 可选 handler），用户在「插件」面板里安装到
// `.easychat/plugins/<id>/`。安装后与用户自建插件走同一条加载路径。
//
// 纯数据，零 IO、可 Node 直测。每个条目的 manifest 必须能过 validateManifest（有自检测试）。
//
// 归类：每个条目的 manifest 显式声明 category（工作区 / 聊天 / 功能 / 其他）。
// 内置条目**写死**而不是靠推断——内置插件的归类是产品裁决，不该随推断规则改动而漂移；
// 推断只服务于没有声明的第三方插件（见 manifest.js 的 inferPluginCategory）。

import { normalizeManifest } from './manifest.js';

export const PLUGIN_MARKET = Object.freeze([
  {
    id: 'workspace-stats',
    name: '工作区统计',
    description: '在设置面板显示工作区文件数，并提供 count_lines 工具统计某个文件的行数。',
    source: 'builtin',
    manifest: {
      id: 'workspace-stats',
      name: '工作区统计',
      pluginVersion: '1.0.0',
      description: '文件数与行数统计。',
      category: 'workspace',
      permissions: ['fs.read'],
      slots: [
        { kind: 'settings.row', id: 'stats', label: '工作区统计', text: '用 count_lines 工具统计文件行数。' },
      ],
      tools: [
        {
          name: 'count_lines',
          description: '统计工作区里某个文本文件的行数。',
          readOnly: true,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '工作区相对路径。' } },
            required: ['path'],
          },
          handler: [
            'if (!ctx.read) return "缺少 fs.read 权限";',
            'const r = await ctx.read(args.path);',
            'const text = (r && r.content) || "";',
            'const lines = text.length ? text.split("\\n").length : 0;',
            'return `${args.path}: ${lines} 行`;',
          ].join('\n'),
        },
      ],
    },
  },
  {
    id: 'todo-list',
    name: '待办清单',
    description: '提供 append_todo 工具，把待办追加到 .easychat/TODO.md。',
    source: 'builtin',
    manifest: {
      id: 'todo-list',
      name: '待办清单',
      pluginVersion: '1.0.0',
      description: '把待办追加到工作区 TODO 文件。',
      category: 'workspace',
      permissions: ['fs.read', 'fs.write'],
      slots: [
        { kind: 'settings.row', id: 'todo', label: '待办清单', text: '用 append_todo 工具追加待办。' },
      ],
      tools: [
        {
          name: 'append_todo',
          description: '把一条待办追加到 .easychat/TODO.md。',
          readOnly: false,
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '待办内容。' } },
            required: ['text'],
          },
          handler: [
            'if (!ctx.read || !ctx.write) return "缺少 fs 权限";',
            'const prev = await ctx.read(".easychat/TODO.md").catch(() => ({ content: "" }));',
            'const line = `- [ ] ${String(args.text || "").trim()}\\n`;',
            'await ctx.write(".easychat/TODO.md", `${(prev && prev.content) || ""}${line}`);',
            'return `已追加待办：${String(args.text || "").trim()}`;',
          ].join('\n'),
        },
      ],
    },
  },
  {
    id: 'date-badge',
    name: '日期徽标',
    description: '在对话面板顶部显示当前日期徽标。',
    source: 'fallback',
    manifest: {
      id: 'date-badge',
      name: '日期徽标',
      pluginVersion: '1.0.0',
      description: '对话顶部日期徽标。',
      category: 'chat',
      permissions: [],
      slots: [
        { kind: 'chat.header', id: 'date', label: '日期', text: '' },
      ],
    },
  },
]);

// 面板用：附带**安装后会落盘的那个** category（来自归一化后的 manifest），
// 而不是让调用方自己从 manifest 里再取一次——两处各取一次迟早会漂移。
export function listMarket() {
  return PLUGIN_MARKET.map(item => {
    const manifest = normalizeManifest(item.manifest);
    return { ...item, manifest, category: manifest.category };
  });
}

export function findMarketPlugin(id) {
  const key = String(id == null ? '' : id).trim().toLowerCase();
  return PLUGIN_MARKET.find(item => item.id === key) || null;
}
