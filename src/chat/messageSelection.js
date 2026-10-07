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

// 判断被删除的消息是否构成「自某点起的连续尾段」。是则返回保留段信息，供撤回路径
// 归档成分支（需求 1.3）；不是则返回 null（普通删除，不建分支）。
// 返回 { kept, tail, forkMessageId }：kept 为保留段，tail 为被删除的连续尾段。
export function getContinuousTailPlan(messages, messageIds) {
  const list = Array.isArray(messages) ? messages : [];
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  if (ids.size === 0) return null;
  const indices = [];
  list.forEach((message, index) => {
    if (message && ids.has(String(message.id || ''))) indices.push(index);
  });
  if (indices.length === 0 || indices.length !== ids.size) return null;
  // 连续且到队尾：删除的是 [start, end)
  const start = indices[0];
  const isContiguous = indices.every((value, offset) => value === start + offset);
  if (!isContiguous) return null;
  if (indices[indices.length - 1] !== list.length - 1) return null;
  const kept = list.slice(0, start);
  const tail = list.slice(start);
  if (tail.length === 0) return null;
  return {
    kept,
    tail,
    forkMessageId: kept.length ? String(kept[kept.length - 1] && kept[kept.length - 1].id || '') : '',
  };
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
