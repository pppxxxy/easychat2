// 主动消息落库（从 AppContext 外提，Z 系采纳 #9「领域化」的一步）。
//
// 原来这段逻辑内联在 AppContext 里（65 行），与 React 状态纠缠，无法单测。
// 外提后：依赖全部注入（角色表、存储原语、写后回调），成为一个**纯领域函数**，
// AppContext 只做一行委托——领域逻辑可测，容器只管装配。

// 把原生待写队列里的主动消息逐条写入各自角色的单聊会话。
// 返回 { written, skipped, deferred, targetSessions }：
//   written        已写入，可 ack 删除；
//   skipped        结构残缺、永远无法处理，可 ack 删除；
//   deferred       暂时处理不了（角色不在库/写入失败），**不 ack**，保留重试；
//   targetSessions roleId → 本次消息实际写入的 sessionId（供通知跳转精确切段）。
export async function ingestProactiveMessagesInto({
  messages,
  characters = [],
  getProactiveSettings,
  appendProactiveMessage,
  bindProactiveSlotSession,
  onWritten = null,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const written = [];
  const skipped = [];
  const deferred = [];
  const targetSessions = {};
  if (list.length === 0) return { written, skipped, deferred, targetSessions };

  // 槽绑定表只读一次；新建后同步更新，保证同一轮多条消息指向同一段新建会话。
  const settings = await getProactiveSettings().catch(() => ({ slots: [] }));
  const slotTargets = new Map(
    (Array.isArray(settings.slots) ? settings.slots : [])
      .map(slot => [String(slot.slotId || ''), String(slot.sessionTargetId || '')])
  );
  const knownCharacters = new Set(
    (Array.isArray(characters) ? characters : []).map(item => String((item && item.id) || ''))
  );

  for (const message of list) {
    const roleId = String((message && message.roleId) || '');
    const id = String((message && message.id) || '');
    const slotId = String((message && message.slotId) || '');
    if (!id) continue; // 没有 id 就无法定位、无法 ack，忽略即可
    if (!roleId) {
      // 连角色都没有，永远无法落库：保留重试也无意义，按可删除处理。
      skipped.push(id);
      continue;
    }
    if (!knownCharacters.has(roleId)) {
      // 角色当前不在库（可能被删、也可能是 id 一时对不上）：保留重试，不删消息。
      deferred.push(id);
      continue;
    }
    try {
      const result = await appendProactiveMessage(roleId, {
        id,
        text: message.text,
        createdAt: message.createdAt,
        sessionTargetId: slotTargets.get(slotId) || '',
      });
      if (result && result.sessionId) {
        written.push(id);
        targetSessions[roleId] = result.sessionId;
        // 首次新建对话：把槽绑定到这段新会话，之后固定复用。
        if (result.created && slotId) {
          slotTargets.set(slotId, result.sessionId);
          await bindProactiveSlotSession(slotId, result.sessionId).catch(() => {});
        }
      } else {
        // 拒写（正文为空等）：永远写不进去，按可删除处理，否则会无限重试并占用队列配额。
        skipped.push(id);
      }
    } catch (error) {
      // 写入失败：保留重试，下次消费者会再取一次。
      deferred.push(id);
    }
  }

  if (written.length > 0 && typeof onWritten === 'function') await onWritten();
  return { written, skipped, deferred, targetSessions };
}
