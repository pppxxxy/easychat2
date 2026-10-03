// 一起看书的段落评论 prompt：纯函数、中文（提示词不做多语言翻译，与全项目同一取舍）。
// 角色人设由 buildRequestMessages 的 system 注入，这里只交代「正在读什么、读到哪、段落原文」。

const EXCERPT_PROMPT_MAX = 600;

export function formatReadingPercent(blockIndex, blockCount, pageIndex, pageCount) {
  const blockTotal = Math.max(1, Math.floor(Number(blockCount)) || 1);
  const pageTotal = Math.max(1, Math.floor(Number(pageCount)) || 1);
  const block = Math.min(blockTotal - 1, Math.max(0, Math.floor(Number(blockIndex)) || 0));
  const page = Math.min(pageTotal - 1, Math.max(0, Math.floor(Number(pageIndex)) || 0));
  const percent = Math.round(((block + (pageTotal > 0 ? page / pageTotal : 0)) / blockTotal) * 100);
  return Math.min(100, Math.max(0, percent));
}

export function buildPassageCommentPrompt({ bookName = '', chapterTitle = '', excerpt = '' } = {}) {
  const book = String(bookName || '').trim() || '一本书';
  const chapter = String(chapterTitle || '').trim();
  const passage = String(excerpt || '').trim().slice(0, EXCERPT_PROMPT_MAX);
  const where = chapter ? `正在读《${book}》的「${chapter}」` : `正在读《${book}》`;
  return [
    `你和用户正在一起看小说，${where}。用户正读到这一段：`,
    passage ? `「${passage}」` : '（这一页还没有文字内容）',
    '请以陪读的身份，用两三句口语化的中文聊聊这段内容——可以是感受、联想，或者抛给用户一个想聊的点；不要复述原文，不要剧透后文，不要使用任何格式标记，直接输出要说的话。',
  ].join('\n');
}
