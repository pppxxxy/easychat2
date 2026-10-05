// 工作区「精确文本替换」的纯逻辑（零依赖，可 Node 直测）。
//
// 为什么默认要求唯一匹配：模型最容易犯的错是拿一小段通用文本（比如一个空行、
// 一句常见台词）去替换，结果把文件里其它地方一起改掉。默认拒绝多处匹配，
// 强制模型给出更具体的上下文；确实需要批量替换时才显式 all:true。
//
// 为什么拒绝替换成空内容：那等于把整块内容删掉，而「清空文件」和「改错一处」
// 在用户看来天差地别。真要删内容应显式给出替代文本，或让用户自己删。

import { tActive } from '../i18n/index.js';

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

  if (!needle) throw new Error(tActive('error.workspace.editFindEmpty'));
  if (!next) throw new Error(tActive('error.workspace.editReplaceEmpty'));

  const count = countOccurrences(text, needle);
  if (count === 0) throw new Error(tActive('error.workspace.editFindNotFound'));
  if (count > 1 && all !== true) {
    throw new Error(tActive('error.workspace.editMultipleMatches', { count }));
  }

  const result = all === true
    ? text.split(needle).join(next)
    : text.replace(needle, () => next);
  return { content: result, count: all === true ? count : 1 };
}

export const EDIT_LIMITS = Object.freeze({ MIN_UNIQUE: 1 });
