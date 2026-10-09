// 工作区记忆文件（AGENTS.md，对齐 Claude Code 的 CLAUDE.md）：
// 放在工作区根目录，每轮组装系统提示时自动注入——**agent 自己也能改它**，
// 于是「用户的长期约定」可以在使用中自我演进（这是这套机制的核心价值，
// 所以绝不能把它设成只读：自我演进的通路必须留在 agent 手里）。
//
// 边界与取舍：
// - 8KB（UTF-8 字节）上限防上下文爆炸：超长按字符边界安全截断，尾部写明，
//   模型与用户都能看到「还有内容没生效」；
// - 注入段与模板都是**发给模型的提示词内容**，按仓库铁律不进 i18n 词条表；
// - 读取**每轮直读、不按 mtime 缓存**：任务书建议缓存，但 agent 可能在上一轮里
//   刚改过它——缓存一旦判断失误（文件系统 mtime 粒度、外部编辑），模型就会按
//   旧指令工作；直读就是一次沙盒 IO，成本可忽略，换「永远最新」。

export const WORKSPACE_MEMORY_FILE = 'AGENTS.md';
export const WORKSPACE_MEMORY_MAX_BYTES = 8192;

// 新建工作区时的模板（可改模式下、文件不存在时写入一次；用户可随意删改）。
// 模板是「自解释」的：既是给模型看的约定，也是写给用户看的说明书。
export const WORKSPACE_MEMORY_TEMPLATE = [
  '# 工作区记忆（AGENTS.md）',
  '',
  '> 这个文件会在每轮对话开始时自动注入给助手，用来记住**长期有效的约定**。',
  '> 直接编辑它，或者让助手帮你改都行；删掉整份文件即恢复默认行为。',
  '',
  '## 项目说明',
  '',
  '- （这是什么项目、目录结构有什么讲究）',
  '',
  '## 约定与偏好',
  '',
  '- 回复一律用中文；代码块之外少写客套话',
  '- 改文件之前先读一遍现状',
  '- 超过三步的任务先列步骤清单；改完代码或配置后先跑一次验证，再把结果写进结论',
  // H1：云构建闭环（手机跑不动构建/测试时，重活交给 GitHub Actions）。
  '- 仓库副本（repos/ 下）改完后，可用 run_remote_build 触发 GitHub Actions 构建/测试，再用 get_build_log 读日志修错——重活不用在手机上跑',
  '- （继续补充你自己的约定…）',
  '',
].join('\n');

// UTF-8 字节长度（手写，不依赖 TextEncoder：Hermes 环境不保证有，实现也简单）。
export function utf8ByteLength(text) {
  const value = String(text == null ? '' : text);
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    // 代理对（emoji 等）占两个 code unit，跳过低位继续。
    if (code > 0xffff) index += 1;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

const TRUNCATE_NOTICE = '\n\n（AGENTS.md 过长已截断：请精简这份记忆文件，超出部分不会生效）';

// 超长截断：按字符边界安全切（不切断多字节字符），尾部留一行明确提示。
export function truncateWorkspaceMemory(content, maxBytes = WORKSPACE_MEMORY_MAX_BYTES) {
  const text = String(content == null ? '' : content);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : WORKSPACE_MEMORY_MAX_BYTES;
  if (utf8ByteLength(text) <= limit) return text;
  const budget = Math.max(0, limit - utf8ByteLength(TRUNCATE_NOTICE));
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > budget) break;
    bytes += size;
    end = index + (code > 0xffff ? 2 : 1);
  }
  return text.slice(0, end) + TRUNCATE_NOTICE;
}

// 注入段（纯函数）：空内容返回空串（调用方据此决定不注入），
// 否则给出「这是什么 + 内容」的完整段落。
export function workspaceMemorySection(raw) {
  const text = truncateWorkspaceMemory(raw).trim();
  if (!text) return '';
  return [
    `【工作区记忆 ${WORKSPACE_MEMORY_FILE}】下面是这个工作区长期有效的约定与偏好，请按它工作：`,
    text,
  ].join('\n');
}

// 读记忆（沙盒）：不存在或读失败一律当空——记忆文件是增强项，不该让聊天报错。
export async function readWorkspaceMemory(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return '';
  try {
    const result = await store.readWorkspaceFile({ characterId, path: WORKSPACE_MEMORY_FILE });
    return String((result && result.content) || '');
  } catch (error) {
    return '';
  }
}

// 首次使用生成模板：只在「可改」模式、文件不存在时写一次；失败静默
// （外部文件夹根可能没有写权限——那就不建，不打扰用户）。
// 返回 true 表示这次真的创建了（调用方可据此刷新文件列表）。
export async function ensureWorkspaceMemory(store, characterId, mode) {
  if (!store || mode !== 'write') return false;
  if (typeof store.writeWorkspaceFile !== 'function') return false;
  try {
    const existing = await store.readWorkspaceFile({ characterId, path: WORKSPACE_MEMORY_FILE });
    if (existing && typeof existing.content === 'string') return false;
  } catch (error) {
    // store 的语义：读取抛错即文件不存在 → 继续创建；其它错误会在写入时再暴露。
  }
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: WORKSPACE_MEMORY_FILE,
      content: WORKSPACE_MEMORY_TEMPLATE,
    });
    return true;
  } catch (error) {
    return false;
  }
}
