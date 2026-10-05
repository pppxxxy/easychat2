// 工作区会话的归一化与裁剪（纯函数，零原生依赖，可 Node 直测）。
//
// 与聊天页的会话分开存：工作区对话直连 agent 工具循环、不参与角色扮演那条流水线，
// 也不进聊天页的会话列表——混在一起会让「角色聊天」被一堆工作区指令淹没。
// 结构：按角色分区的 { [characterId]: { activeId, chats: [...] } }。
//
// 裁剪是必须的：工作区对话包含工具调用前后的长回复，不设上限会把 AsyncStorage 撑爆。

export const WORKSPACE_CHAT_LIMIT = 40;
export const WORKSPACE_CHAT_MESSAGE_LIMIT = 200;
export const WORKSPACE_CHAT_TITLE_MAX = 60;
const MESSAGE_CONTENT_MAX = 20000;

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function makeWorkspaceChatId() {
  return `wc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeWorkspaceChatMessage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || `wcm-${Math.random().toString(36).slice(2, 10)}`),
    role: source.role === 'assistant' ? 'assistant' : 'user',
    content: truncate(source.content, MESSAGE_CONTENT_MAX),
    isError: source.isError === true,
    at: Math.max(0, Math.floor(Number(source.at)) || 0),
  };
}

// 标题取自首条用户指令（多行只取第一行，够长就截断）；没有用户消息时留空，
// 由界面显示「新对话」——不在这里塞本地化文案（纯函数不引 i18n）。
export function deriveWorkspaceChatTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find(item => item && item.role === 'user' && String(item.content || '').trim());
  if (!first) return '';
  const line = String(first.content).trim().split('\n')[0].trim();
  return truncate(line, WORKSPACE_CHAT_TITLE_MAX);
}

export function normalizeWorkspaceChat(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const messages = (Array.isArray(source.messages) ? source.messages : [])
    .map(normalizeWorkspaceChatMessage)
    .slice(-WORKSPACE_CHAT_MESSAGE_LIMIT);
  const createdAt = Math.max(0, Math.floor(Number(source.createdAt)) || 0);
  const updatedAt = Math.max(0, Math.floor(Number(source.updatedAt)) || createdAt);
  return {
    id: String(source.id || makeWorkspaceChatId()),
    // 标题为空时用消息现推一次：老数据或导入时没有标题也能在列表里认出来。
    title: truncate(source.title, WORKSPACE_CHAT_TITLE_MAX) || deriveWorkspaceChatTitle(messages),
    createdAt,
    updatedAt,
    messages,
  };
}

// 新会话排在最前；超出上限的按 updatedAt 从旧到新裁掉。
export function upsertWorkspaceChat(list, chat) {
  const next = [normalizeWorkspaceChat(chat), ...(Array.isArray(list) ? list : [])]
    .filter((item, index, array) => (
      item && item.id && array.findIndex(other => other.id === item.id) === index
    ))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return next.slice(0, WORKSPACE_CHAT_LIMIT);
}

export function normalizeWorkspaceChatsStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  Object.entries(source).forEach(([characterId, value]) => {
    const key = String(characterId || '').trim();
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const chats = (Array.isArray(value.chats) ? value.chats : [])
      .map(normalizeWorkspaceChat)
      .filter(item => item.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      // 同 id 只留最新那条（排序之后去重，保留的就是 updatedAt 最大的）。
      // 脏数据一旦带重复 id，列表渲染与切换都会指向两条不同的消息体。
      .filter((item, index, array) => array.findIndex(other => other.id === item.id) === index)
      .slice(0, WORKSPACE_CHAT_LIMIT);
    const requested = String(value.activeId || '').trim();
    out[key] = {
      // 选中的会话若已不在清单里就回落最新的一条，避免指向被裁掉/删掉的会话。
      activeId: chats.some(item => item.id === requested) ? requested : (chats[0] ? chats[0].id : ''),
      chats,
    };
  });
  return out;
}

export function emptyWorkspaceChats() {
  return { activeId: '', chats: [] };
}
