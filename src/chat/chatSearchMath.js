// 聊天内搜索的纯逻辑：匹配消息与循环推进匹配下标。从 useChatSearch 抽出便于单测。

import { getMessagePromptText } from './chatMedia.js';
import { ASSISTANT_ID, USER_ID } from './chatConstants.js';

// 命中消息的 id 列表（保持消息顺序）。query 去空白并小写，空查询返回空数组。
export function collectSearchMatchIds(messages, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  return (Array.isArray(messages) ? messages : [])
    .filter(message => (
      message
      && (message.role === USER_ID || message.role === ASSISTANT_ID)
      && getMessagePromptText(message).toLowerCase().includes(needle)
    ))
    .map(message => message.id);
}

// 在命中列表里按 delta 循环推进下标：到底回到头，到头回到尾。
export function advanceMatchIndex(activeMatchIndex, delta, matchCount) {
  if (!Number.isFinite(matchCount) || matchCount <= 0) return 0;
  const current = Math.trunc(Number(activeMatchIndex)) || 0;
  const step = Math.trunc(Number(delta)) || 0;
  return ((current + step) % matchCount + matchCount) % matchCount;
}
