export function toggleMessageSelection(selectedIds, messageId) {
  const current = Array.isArray(selectedIds)
    ? selectedIds.map(id => String(id || '')).filter(Boolean)
    : [];
  const id = String(messageId || '');
  if (!id) return current;
  return current.includes(id)
    ? current.filter(selectedId => selectedId !== id)
    : [...current, id];
}

// 可进入多选的稳定消息 id：排除生成中的占位消息（pending），与消息 Pressable 的
// disabled 判定保持一致。返回字符串 id 数组，供「全选」使用。
export function selectableMessageIds(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.id && !message.pending)
    .map(message => String(message.id));
}

export function removeMessagesByIds(messages, messageIds) {
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  return (Array.isArray(messages) ? messages : [])
    .filter(message => !message || !ids.has(String(message.id || '')));
}

// 撤回后回填到附件区的图片/表情包描述符。
// size 故意留 0：发送路径会用 getImageFileInfo 重新 stat 磁盘（见 useChatSend 的
// sizedImages），不依赖这里存的数值；写死错误的大小反而会误导。
function attachmentFromMediaMessage(message) {
  const image = (message && message.image) || {};
  const uri = String(image.uri || '');
  if (!uri) return null;
  const item = {
    id: `restore-${String(message.id || Date.now())}`,
    kind: message.kind || 'image',
    name: String(image.name || image.stickerName || ''),
    uri,
    mime: String(image.mime || 'image/jpeg'),
    size: 0,
    width: Number(image.width) || 0,
    height: Number(image.height) || 0,
  };
  if (image.stickerId) item.stickerId = String(image.stickerId);
  if (image.stickerName) item.stickerName = String(image.stickerName);
  return item;
}

// 修改重发计划。文字消息回填正文；图片/表情包消息改为回填到附件区——
// 文件本身已在文档目录，重新落入附件即被「待发送附件 URI」保护集合覆盖，
// 后续落盘触发的孤儿文件回收不会把它删掉。
export function getEditResendPlan(messages, targetId) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(targetId || '');
  const index = list.findIndex(message => message && String(message.id || '') === id);
  const target = index >= 0 ? list[index] : null;
  if (!target || target.role !== 'user') return null;
  const messages_ = list.slice(0, index);
  if (target.image) {
    const attachment = attachmentFromMediaMessage(target);
    if (!attachment) return null;
    return { text: '', attachments: [attachment], messages: messages_ };
  }
  return {
    text: String(target.text || ''),
    attachments: [],
    messages: messages_,
  };
}
