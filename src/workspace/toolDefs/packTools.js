// 扩展包工具（P2-6）：把声明式扩展打包 / 安装。见 workspace/packs.js。
//
// export_extension_pack：只读——收集工作区扩展，返回包的 JSON 文本（模型可自行写文件分享）。
// install_extension_pack：可写——把包里的扩展文件写入工作区（默认不覆盖已有）。

import { collectWorkspacePack, installWorkspacePack, serializePack } from '../packs.js';

export const EXPORT_PACK_TOOL_DEFINITION = {
  name: 'export_extension_pack',
  description: '把当前工作区的声明式扩展（.easychat/skills、commands、agents、teams、hooks.json）'
    + '打包成一个可分享的扩展包 JSON，返回其内容（可用 write_workspace_file 存成文件）。'
    + '需要分享/备份/迁移扩展时用。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '包名（缺省 extension-pack）。' },
      description: { type: 'string', description: '可选：一句话描述。' },
    },
  },
  execute: async (options, args, ctx) => {
    const pack = await collectWorkspacePack(options.store, ctx && ctx.characterId, {
      name: String((args && args.name) || '').trim() || 'extension-pack',
      description: String((args && args.description) || '').trim(),
    });
    if (!pack.files || pack.files.length === 0) {
      return { content: '这个工作区还没有可打包的声明式扩展（skills / commands / agents / teams / hooks）。', isError: true };
    }
    return { content: serializePack(pack) };
  },
};

export const INSTALL_PACK_TOOL_DEFINITION = {
  name: 'install_extension_pack',
  description: '安装一个扩展包（export_extension_pack 产出的 JSON）：把其中的 skills / commands / '
    + 'agents / teams / hooks 文件写入工作区。默认**不覆盖**已存在的同名文件（幂等）；'
    + '要覆盖传 overwrite=true。pack 可以是 JSON 字符串或对象。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      pack: {
        type: ['string', 'object'],
        description: '扩展包内容（JSON 字符串或对象，含 format/version/files）。',
      },
      overwrite: { type: 'boolean', description: '可选：true 则覆盖已存在的同名文件（默认 false）。' },
    },
    required: ['pack'],
  },
  execute: async (options, args, ctx) => {
    const pack = args && args.pack !== undefined ? args.pack : args;
    const result = await installWorkspacePack(options.store, ctx && ctx.characterId, pack, {
      overwrite: !!(args && args.overwrite),
    });
    if (result.installed === 0 && result.skipped.length === 0) {
      return { content: `安装失败：${(result.errors || []).join('；') || '包无效'}`, isError: true };
    }
    const lines = [`已安装 ${result.installed} 个扩展文件。`];
    if (result.skipped.length) {
      lines.push(`跳过 ${result.skipped.length} 个已存在文件（要覆盖请传 overwrite=true）：${result.skipped.join('、')}`);
    }
    if (result.errors.length) lines.push(`失败：${result.errors.join('、')}`);
    return { content: lines.join('\n') };
  },
};
