// 只读工具定义（列表 / 读取）：零写副作用，read 与 write 模式都暴露。
//
// 按域拆文件的原因：加载「工作区工具定义」不该把 Word 导出（fflate）、子代理
// （网络链路）、命令执行的形态全拖进来——绝大多数工具（读/写/子代理）用不到
// docx，拆开后各域的重依赖只在自己文件里。
//
// 文件内容按「内容型」写死，不进 i18n 词条表（工具描述是发给模型的提示词，
// 仓库既有口径；界面文案才走词条）。

import { WORKSPACE_LIMITS } from '../store.js';

// 读取结果 → 工具输出文本。默认（从头读完整）原样返回（兼容既有行为）；
// 截断/分段时附续读提示，让模型知道总长与下一段 offset——大文件因此可分段读完。
export function formatWorkspaceReadResult(result) {
  const content = String((result && result.content) || '');
  const total = Number(result && result.total);
  const nextOffset = Number(result && result.nextOffset);
  if (Number.isFinite(total) && result && result.truncated === true && Number.isFinite(nextOffset)) {
    return `${content}\n…（已截断：共 ${total} 字符，本次为 ${result.offset}–${nextOffset}；继续读取请用 offset=${nextOffset}）`;
  }
  if (Number.isFinite(total) && Number(result && result.offset) > 0) {
    return `${content}\n（已到文件末尾：共 ${total} 字符）`;
  }
  return content;
}

export const READ_ONLY_TOOL_DEFINITIONS = [
  {
    name: 'list_workspace_files',
    description: '列出工作区内的文件（相对路径；目录以 / 结尾）。可用来了解项目结构；也可用 match 按文件名子串查找文件（如 match: "test"）。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: '可选：只列出该子目录下的内容。' },
        match: { type: 'string', description: '可选：只列出文件名（不含目录路径）包含该子串的文件，不区分大小写。给出 match 时结果里不再包含目录项。' },
      },
    },
    execute: (options, args, ctx) => {
      const params = {
        characterId: ctx && ctx.characterId,
        subdir: typeof args.subdir === 'string' ? args.subdir : '',
        match: typeof args.match === 'string' ? args.match : '',
      };
      const store = options.store;
      // 优先用带截断标记的变体（legacy / SAF 后端都提供）；注入的桩后端可能只有旧方法，
      // 此时退化为「无截断标记」，行为与旧版一致。
      const listing = typeof store.listWorkspaceFilesWithMeta === 'function'
        ? store.listWorkspaceFilesWithMeta(params)
        : Promise.resolve(store.listWorkspaceFiles(params))
          .then(files => ({ files: Array.isArray(files) ? files : [], truncated: false }));
      return listing.then(({ files, truncated }) => {
        const list = Array.isArray(files) ? files : [];
        const body = list.length ? list.join('\n') : '（工作区为空）';
        // 触达 MAX_FILES 上限时如实报数：结果可能不完整，提示收窄范围（G 系「跳过/截断
        // 如实可见」的同一原则）。
        return truncated
          ? `${body}\n…（已达上限 ${WORKSPACE_LIMITS.MAX_FILES} 条，结果可能不完整；可用 subdir 或 match 收窄范围）`
          : body;
      });
    },
  },
  {
    name: 'read_workspace_file',
    description: '读取工作区内某个文本文件（源码、配置、Markdown 等）。大文件可分段读：默认从头读最多 100 万字符，返回里会标注总长与下一段 offset，必要时用 offset/limit 继续读。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径（如 src/index.js、README.md）。' },
        offset: { type: 'number', description: '可选：从文件第几个字符开始读（默认 0）。' },
        limit: { type: 'number', description: '可选：本次最多读取的字符数（默认与上限 1000000）。' },
      },
      required: ['path'],
    },
    execute: (options, args, ctx) => {
      const rawOffset = Number(args.offset);
      const rawLimit = Number(args.limit);
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      const maxChars = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), WORKSPACE_LIMITS.MAX_READ_CHARS)
        : undefined;
      return options.store.readWorkspaceFile({
        characterId: ctx && ctx.characterId,
        path: args.path,
        offset,
        ...(maxChars !== undefined ? { maxChars } : {}),
      }).then(result => {
        // A5 已读登记：成功后记 { path, chars }（用文件总长——「这个文件多大」比
        // 「这次读了多少」更接近清单的语义）。没注入 readLog 的宿主（如聊天页）安全跳过。
        if (options.readLog && typeof options.readLog.record === 'function') {
          try {
            const chars = Number(result && result.total);
            options.readLog.record(
              args.path,
              Number.isFinite(chars) ? chars : String((result && result.content) || '').length
            );
          } catch (error) {}
        }
        return formatWorkspaceReadResult(result);
      }, error => {
        // C2：清单内未物化文件——读失败时试一次按需物化再读。物化器由宿主注入
        //（工作区 ChatPanel）；没注入（如聊天页）= 与旧版行为逐字节一致。
        // 物化器内部三查（repos 路径 / 有清单 / 文件在清单里），不满足即 false
        // 不发起网络——所以这里无脑试一次是安全的。
        if (typeof options.materializer !== 'function') throw error;
        return Promise.resolve(options.materializer(args.path))
          .then(done => {
            if (!done) throw error;
            return options.store.readWorkspaceFile({
              characterId: ctx && ctx.characterId,
              path: args.path,
              offset,
              ...(maxChars !== undefined ? { maxChars } : {}),
            });
          })
          .then(formatWorkspaceReadResult);
      });
    },
  },
];
