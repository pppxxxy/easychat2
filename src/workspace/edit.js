// 工作区「精确文本替换」的纯逻辑（零依赖，可 Node 直测）。
//
// 为什么默认要求唯一匹配：模型最容易犯的错是拿一小段通用文本（比如一个空行、
// 一句常见台词）去替换，结果把文件里其它地方一起改掉。默认拒绝多处匹配，
// 强制模型给出更具体的上下文；确实需要批量替换时才显式 all:true。
//
// 为什么拒绝替换成空内容：那等于把整块内容删掉，而「清空文件」和「改错一处」
// 在用户看来天差地别。真要删内容应显式给出替代文本，或让用户自己删。

export function countOccurrences(content, find) {
  const text = String(content === undefined || content === null ? '' : content);
  const needle = String(find === undefined || find === null ? '' : find);
  if (!needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function applyWorkspaceEdit({ content, find, replace, all = false } = {}) {
  const text = String(content === undefined || content === null ? '' : content);
  const needle = String(find === undefined || find === null ? '' : find);
  const next = String(replace === undefined || replace === null ? '' : replace);

  if (!needle) throw new Error('要替换的原文（find）不能为空。');
  if (!next) throw new Error('替换后的内容（replace）不能为空；如需删除内容请自己写出改后的完整文本。');

  const count = countOccurrences(text, needle);
  if (count === 0) throw new Error('未找到要替换的原文（find）：请逐字核对，包含缩进与换行。');
  if (count > 1 && all !== true) {
    throw new Error(`匹配到 ${count} 处，请给出更具体的内容，或加 all:true 一次全部替换。`);
  }

  const result = all === true
    ? text.split(needle).join(next)
    : text.replace(needle, () => next);
  return { content: result, count: all === true ? count : 1 };
}

export const EDIT_LIMITS = Object.freeze({ MIN_UNIQUE: 1 });
