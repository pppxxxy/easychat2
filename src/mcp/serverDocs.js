// 内置 MCP Server 的 `resources/*` 文档（纯函数，Node 可直测）。
//
// 为什么把文档做成资源而不是塞进 initialize 的 instructions：instructions 只在握手时读一次，
// 而档位、工具表、工作区根都会变；agent 需要「随时能再读一遍当前事实」。URI 形态照 Tavo 的
// `tavo://docs/*` 来（agent 侧心智一致），内容全部由**活的能力**生成——工具清单直接从注册表
// 派生，档位状态直接从当前设置派生，不手抄一份会漂移的副本。

import { MCP_ACCESS_TIERS, normalizeMcpTiers, tierNeedsConfirm } from './serverPolicy.js';

export const MCP_RESOURCE_PREFIX = 'easychat://';

export const MCP_DOC_URIS = Object.freeze({
  TOOLS: `${MCP_RESOURCE_PREFIX}docs/tools`,
  WRITE_SAFETY: `${MCP_RESOURCE_PREFIX}docs/write-safety`,
  ACCESS: `${MCP_RESOURCE_PREFIX}docs/access`,
  WORKSPACE: `${MCP_RESOURCE_PREFIX}docs/workspace`,
});

const TIER_TITLE = { read: '只读', write: '写入', exec: '执行' };
const TIER_SUMMARY = {
  read: '读文件、搜索、看 git 状态/日志、读公告板。不产生副作用。',
  write: '建目录/写文件/精确替换、物化仓库、导出 docx 与扩展包、git 提交与回滚、写计划、发公告板消息。',
  exec: '跑命令、跑 Python、触发云构建、安装扩展包，以及 run_subagent / run_team / run_workflow（它们会把工具表交给模型自己挑，等于把执行权转交出去）。',
};

function tierLine(tier, tiers) {
  const on = normalizeMcpTiers(tiers)[tier] === true;
  const need = tierNeedsConfirm(tier) ? '，且必须先看预览再带 confirm: true 重发' : '';
  return `- ${tier}（${TIER_TITLE[tier]}）：${on ? '已开启' : '未开启'}${on ? need : ''}。${TIER_SUMMARY[tier]}`;
}

function groupByTier(catalog) {
  const groups = { read: [], write: [], exec: [] };
  for (const item of Array.isArray(catalog) ? catalog : []) {
    if (groups[item.tier]) groups[item.tier].push(item);
  }
  return groups;
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

export function buildMcpResourceList({ catalog = [], tiers } = {}) {
  const resolved = normalizeMcpTiers(tiers);
  const groups = groupByTier(catalog);
  const count = tier => groups[tier].length;
  return [
    {
      uri: MCP_DOC_URIS.TOOLS,
      name: '工具清单与调用约定',
      description: `当前可调用的工具（只读 ${count('read')} / 写入 ${count('write')} / 执行 ${count('exec')}，按档位过滤）。`,
      mimeType: 'text/markdown',
    },
    {
      uri: MCP_DOC_URIS.WRITE_SAFETY,
      name: '写入安全与预览流程',
      description: `写入与执行档的调用流程、被拒绝时的表现、超时语义。当前写入档${resolved.write ? '已开启' : '未开启'}。`,
      mimeType: 'text/markdown',
    },
    {
      uri: MCP_DOC_URIS.ACCESS,
      name: '访问档位说明',
      description: '三个档位各自意味着什么、默认值、以及用户在哪里改。',
      mimeType: 'text/markdown',
    },
    {
      uri: MCP_DOC_URIS.WORKSPACE,
      name: '工作区沙盒说明',
      description: '工具作用的目录在哪、角色沙盒怎么选、character_id 控制字段怎么用。',
      mimeType: 'text/markdown',
    },
  ];
}

export function buildMcpResourceText({ uri, catalog = [], tiers, workspace = null } = {}) {
  const resolved = normalizeMcpTiers(tiers);
  const groups = groupByTier(catalog);
  const target = String(uri || '');

  if (target === MCP_DOC_URIS.TOOLS) {
    const lines = [
      '# easychat2 内置 MCP Server — 工具清单',
      '',
      '## 当前档位',
      ...MCP_ACCESS_TIERS.map(tier => tierLine(tier, resolved)),
      '',
      '## 调用约定',
      '- tools/call 的参数放 `arguments`；返回 `content[].text` 是纯文本结果，`isError: true` 表示这次调用没成功（**不代表服务器不支持**）。',
      '- 控制字段（会被剥离，不会传给工具本身）：',
      '  - `confirm: true` —— 写入/执行档的工具必须带它才真的执行；不带只返回预览。',
      '  - `preview: true` —— 显式只要预览。',
      '  - `character_id` —— 指定操作哪个角色的工作区沙盒（见 easychat://docs/workspace）。',
      '- 写入/执行档的工具**第一次调用只会得到预览**，这是设计如此，不是失败。',
      '',
      '## 工具',
    ];
    for (const tier of MCP_ACCESS_TIERS) {
      const items = groups[tier];
      lines.push('', `### ${tier}（${TIER_TITLE[tier]}）— ${items.length} 个`);
      if (items.length === 0) {
        lines.push('- （当前无可用工具）');
        continue;
      }
      for (const item of items) {
        lines.push(`- \`${item.name}\`：${firstLine(item.description) || '（无描述）'}`);
      }
    }
    return lines.join('\n');
  }

  if (target === MCP_DOC_URIS.WRITE_SAFETY) {
    return [
      '# 写入安全与预览流程',
      '',
      '本服务器的写入/执行类工具**默认关闭**，且即使开启也必须先预览后执行：',
      '',
      '1. 直接调用（不带 confirm）→ 返回 `isError: true` 的预览文本，写明工具名、档位与完整参数，**没有任何副作用**。',
      '2. 判断无误后，带 `confirm: true` 重发同一调用 → 真正执行。',
      '3. 用户也可以直接关闭档位；那时调用会返回「该工具属于 X 档，当前未开启」，不要重试，改请用户去设置里开。',
      '',
      '为什么是 isError: true：这次调用**确实没有执行**，按成功上报会让上层以为已经改了东西。',
      '',
      '## 其它仍然生效的闸门',
      '- 工作区钩子（`.easychat/hooks.json`）的 `before_tool` deny 规则对任意工具生效，命中即拒绝，且**连预览都不会给**。',
      '- 执行类工具本身有超时（run_shell / run_python 由原生看门狗强杀）。超时的返回是「结果未知」而不是「失败」：操作可能已经生效，**先用只读工具确认实际状态，不要盲目重跑写操作**。',
      '- 工作区根是外部文件夹（SAF）时，部分工具（git 三件套等）本来就不存在——`tools/list` 里看不到即不可用。',
    ].join('\n');
  }

  if (target === MCP_DOC_URIS.ACCESS) {
    return [
      '# 访问档位',
      '',
      ...MCP_ACCESS_TIERS.map(tier => tierLine(tier, resolved)),
      '',
      '默认只开只读。档位由用户在 **设置 → MCP 服务器** 里逐个打开；打开即代表用户对「该类操作可以由外部 agent 发起」给出总授权。',
      '',
      '除此之外还有两道与档位无关的闸门：工作区钩子的 deny 规则（见 easychat://docs/write-safety），以及工具自身的实现边界（例如 shell 开关关着时 run_shell 根本不注册）。',
    ].join('\n');
  }

  if (target === MCP_DOC_URIS.WORKSPACE) {
    const lines = [
      '# 工作区沙盒',
      '',
      '所有文件类工具都作用在 App 的**工作区沙盒**里，不是设备任意路径：',
    ];
    if (workspace && workspace.root) {
      lines.push(`- 当前根：${workspace.root}`);
      lines.push(`- 根类型：${workspace.kind === 'saf' ? '用户选择的外部文件夹（SAF）' : '应用私有目录'}`);
    } else {
      lines.push('- 根位置由 App 的工作区设置决定（应用私有目录或用户选择的外部文件夹）。');
    }
    lines.push(
      '- 路径一律写**相对路径**（例如 `notes/a.md`），不要写绝对路径。',
      '- 单聊/角色维度还有一层沙盒：`<root>/<characterId>/`。默认用工作助手（App 内置助手）的沙盒；',
      '  要操作某个角色自己的沙盒，在 arguments 里带 `character_id`（角色 id 可从 App 的角色页查看）。',
      '- 写文件前先 `list_workspace_files` / `read_workspace_file` 确认现状；覆盖是直接覆盖，没有回收站。'
    );
    return lines.join('\n');
  }

  return null;
}
