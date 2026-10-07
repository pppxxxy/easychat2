// 会话消息全库搜索：按会话分批读取后线性扫描。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。

import { getSessions } from '../sessionCore.js';
import { getMessagesBySessionStatus } from './messages.js';

// ---------- 全库搜索 ----------

export async function searchMessages(keyword, options = {}) {
  const signal = options && options.signal ? options.signal : null;
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const error = new Error('搜索已取消');
      error.name = 'AbortError';
      throw error;
    }
  };
  throwIfAborted();
  const query = String(keyword || '').trim();
  if (!query) return [];
  const sessions = await getSessions();
  throwIfAborted();
  if (sessions.length === 0) return [];
  const needle = query.toLowerCase();
  const results = [];
  for (let offset = 0; offset < sessions.length; offset += 8) {
    throwIfAborted();
    const batch = sessions.slice(offset, offset + 8);
    const states = await Promise.all(batch.map(async session => ({
      session,
      state: await getMessagesBySessionStatus(session.id).catch(() => ({
        status: 'corrupt',
        messages: [],
      })),
    })));
    throwIfAborted();
    for (const { session, state } of states) {
      if (!state || state.status !== 'ok') continue;
      for (const message of state.messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = String(
          message.text
          || (message.image && (message.image.stickerName || message.image.name))
          || ''
        );
        if (!text || !text.toLowerCase().includes(needle)) continue;
        results.push({
          sessionId: session.id,
          sessionType: session.type || 'single',
          sessionName: String(session.name || ''),
          characterId: session.characterId,
          messageId: message.id,
          role: message.role,
          text,
          updatedAt: session.updatedAt || 0,
        });
      }
    }
  }
  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return results;
}
