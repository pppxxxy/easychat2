// 压力探针（真实数据量）：在打包版上造 50 个角色 / 1000 条消息的会话 / 100MB 备份包，
// 量测关键路径耗时，回答「数据量上来之后会不会卡或失败」。
//
// 两阶段设计（必须的）：
//   phase=seed     直接写存储造数据。**不能在同一轮里量渲染**——应用已经加载过旧数据，
//                  不重读就看不到新会话（第一版就是这里量到 bubblesMounted=0）。
//   phase=measure  主进程 reload 之后再调用：此时应用才真正读到压力数据，于是可量
//                  「首屏渲染耗时」与「实际挂载的气泡数」（窗口化是否生效）。
//
// 存储结构必须按**真实分键格式**写（这是第一版踩的坑）：
//   · 角色本体：@easychat2_character_item::<id>；索引：@easychat2_character_index = { ids, revision }；
//   · 会话：@easychat2_sessions；消息：@easychat2_messages::<sessionId>；
//   · 活跃指针：@easychat2_active_character / @easychat2_active_session。
//   **绝不能**写 @easychat2_characters：那是旧版整库键，写入不合规形状会被判 corrupt 并备份。
//
// 判据都写成可读的毫秒数，不设绝对阈值（阈值随机器差异太大）；ok 只表示
// 「数据写对了 + 读回来了 + 界面真的渲染出气泡」。

// 固定前缀：cleanup 只按它删，绝不会误删用户数据。
const STRESS_PREFIX = 'stress-';
const STRESS_SESSION = 'stress-session-1000';
const STRESS_MESSAGE_COUNT = 1000;
const STRESS_CHARACTER_COUNT = 50;
const BACKUP_BYTES = 100 * 1024 * 1024;

const CHARACTER_ITEM_PREFIX = '@easychat2_character_item::';
const CHARACTER_INDEX_KEY = '@easychat2_character_index';
const ACTIVE_CHARACTER_KEY = '@easychat2_active_character';
const SESSIONS_KEY = '@easychat2_sessions';
const ACTIVE_SESSION_KEY = '@easychat2_active_session';
const MESSAGES_PREFIX = '@easychat2_messages::';

function heapMB() {
  // Chrome 专有：拿不到就报 0，不编造数字。
  const perf = globalThis.performance;
  const mem = perf && perf.memory ? perf.memory : null;
  return mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : 0;
}

function buildMessages(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const isUser = i % 2 === 0;
    list.push({
      id: `${STRESS_PREFIX}msg-${i}`,
      role: isUser ? 'user' : 'assistant',
      text: isUser
        ? `用户第 ${i} 条消息。${'这是一段用于压测的较长文本。'.repeat(3)}`
        : `角色第 ${i} 条回复。**加粗** 与 代码 混排。${'内容填充。'.repeat(6)}`,
      createdAt: 1700000000000 + i * 1000,
    });
  }
  return list;
}

async function seed({ bridge }) {
  const out = { phase: 'seed', attempted: true, ok: false, errors: [] };
  const t00 = Date.now();
  try {
    out.heapBeforeMB = heapMB();

    // ---- 1) 50 个角色（分键写，与真实格式一致）----
    const previousIndexRaw = await bridge.kv.get(CHARACTER_INDEX_KEY);
    let previousIds = [];
    let previousRevision = 0;
    try {
      const parsed = JSON.parse(previousIndexRaw || 'null');
      if (Array.isArray(parsed)) {
        previousIds = parsed.map(String);
      } else if (parsed && Array.isArray(parsed.ids)) {
        previousIds = parsed.ids.map(String);
        const revision = Number(parsed.revision);
        previousRevision = Number.isFinite(revision) && revision >= 0 ? revision : 0;
      }
    } catch (error) {
      previousIds = [];
    }
    const keptIds = previousIds.filter(id => !id.startsWith(STRESS_PREFIX));
    const stressIds = [];
    const entries = [];
    for (let i = 0; i < STRESS_CHARACTER_COUNT; i += 1) {
      const id = `${STRESS_PREFIX}char-${i}`;
      stressIds.push(id);
      entries.push([`${CHARACTER_ITEM_PREFIX}${id}`, JSON.stringify({
        id,
        name: `压测角色 ${i}`,
        description: `用于压力验证的角色 ${i}。${'描述文本。'.repeat(20)}`,
        personality: '冷静',
        scenario: '测试场景',
        firstMes: '你好',
        systemPrompt: '',
        tags: ['压测'],
        createdAt: 1700000000000 + i,
      })]);
    }
    if (typeof bridge.kv.multiSet === 'function') {
      await bridge.kv.multiSet(entries);
    } else {
      for (const entry of entries) await bridge.kv.set(entry[0], entry[1]);
    }
    // 索引：{ ids, revision }。revision 递增，避免与应用内的旧快照冲突。
    await bridge.kv.set(CHARACTER_INDEX_KEY, JSON.stringify({
      ids: [...keptIds, ...stressIds],
      revision: previousRevision + 1,
    }));
    out.charactersWriteMs = Math.round(Date.now() - t00);
    out.charactersCount = STRESS_CHARACTER_COUNT;

    // ---- 2) 1000 条消息的会话 ----
    const t1 = Date.now();
    const messages = buildMessages(STRESS_MESSAGE_COUNT);
    const payload = JSON.stringify(messages);
    await bridge.kv.set(`${MESSAGES_PREFIX}${STRESS_SESSION}`, payload);
    out.messagesWriteMs = Math.round(Date.now() - t1);
    out.messagesCount = STRESS_MESSAGE_COUNT;
    out.messagesPayloadMB = Math.round((payload.length / (1024 * 1024)) * 10) / 10;

    // 会话表：追加一条（形状跟现有表保持一致：数组或 { sessions }）。
    const rawSessions = await bridge.kv.get(SESSIONS_KEY);
    let parsedSessions = null;
    try { parsedSessions = JSON.parse(rawSessions || 'null'); } catch (error) { parsedSessions = null; }
    const sessionList = Array.isArray(parsedSessions)
      ? parsedSessions
      : (parsedSessions && Array.isArray(parsedSessions.sessions) ? parsedSessions.sessions : []);
    const keptSessions = sessionList.filter(item => item && !String(item.id).startsWith(STRESS_PREFIX));
    keptSessions.push({
      id: STRESS_SESSION,
      characterId: stressIds[0],
      name: '压测会话（1000 条）',
      createdAt: 1700000000000,
      updatedAt: 1700000000000 + STRESS_MESSAGE_COUNT * 1000,
      type: 'single',
    });
    const nextSessions = Array.isArray(parsedSessions)
      ? keptSessions
      : { ...(parsedSessions && typeof parsedSessions === 'object' ? parsedSessions : {}), sessions: keptSessions };
    await bridge.kv.set(SESSIONS_KEY, JSON.stringify(nextSessions));

    // 活跃指针：让重载后直接落在压测会话上（否则还要用户点两下才能测渲染）。
    await bridge.kv.set(ACTIVE_CHARACTER_KEY, JSON.stringify(stressIds[0]));
    await bridge.kv.set(ACTIVE_SESSION_KEY, JSON.stringify(STRESS_SESSION));

    // ---- 3) 冷读回（确认写进去的能原样读出来）----
    const t2 = Date.now();
    const readBack = await bridge.kv.get(`${MESSAGES_PREFIX}${STRESS_SESSION}`);
    out.messagesReadMs = Math.round(Date.now() - t2);
    out.messagesReadOK = typeof readBack === 'string' && readBack.length === payload.length;

    // ---- 4) 100MB 备份包：写 + 读回 + 删除 ----
    const docs = await bridge.app.info();
    const documentsRoot = String((docs && docs.documents) || '');
    out.documents = documentsRoot;
    if (documentsRoot) {
      const filePath = `${documentsRoot}stress-backup-100mb.json`;
      try {
        const body = `{"marker":"stress","data":"${'x'.repeat(BACKUP_BYTES)}"}`;
        const t4 = Date.now();
        await bridge.fs.write(filePath, body, 'utf8');
        out.backupWriteMs = Math.round(Date.now() - t4);
        out.backupSizeMB = Math.round((body.length / (1024 * 1024)) * 10) / 10;

        const t5 = Date.now();
        const readBody = await bridge.fs.read(filePath, 'utf8');
        out.backupReadMs = Math.round(Date.now() - t5);
        out.backupReadOK = typeof readBody === 'string' && readBody.length === body.length;
      } catch (error) {
        out.errors.push(`backup: ${String((error && error.message) || error).slice(0, 120)}`);
      } finally {
        try { await bridge.fs.delete(filePath, true); } catch (error) {}
      }
    }

    out.heapAfterMB = heapMB();
    out.heapDeltaMB = out.heapAfterMB - out.heapBeforeMB;
    // 数据保留给 measure 阶段；这里只判「写进去的能读回来」。
    out.ok = out.errors.length === 0 && out.messagesReadOK === true;
  } catch (error) {
    out.errors.push(String((error && error.message) || error).slice(0, 200));
  }
  return out;
}

async function measure({ bridge }) {
  const out = { phase: 'measure', attempted: true, ok: false, errors: [] };
  try {
    out.heapMB = heapMB();
    const t0 = Date.now();
    // 重载后应用应已按活跃指针落在压测会话上；等 React 首帧 + 窗口化挂载。
    let bubbles = document.querySelectorAll('[data-message-id]');
    for (let i = 0; i < 20 && bubbles.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      bubbles = document.querySelectorAll('[data-message-id]');
    }
    out.bubblesMounted = bubbles.length;
    out.renderMs = Math.round(Date.now() - t0);
    // 窗口化判据：1000 条会话里挂载的应远少于 1000（共享 MESSAGE_WINDOW_INITIAL=80）。
    out.bubblesWindowed = bubbles.length > 0 && bubbles.length < 300;
    const text = document.body.innerText || '';
    out.loadEarlierSeen = text.includes('加载更早消息') || text.includes('Load earlier');

    // 清理：只删 stress- 前缀的数据，绝不碰用户数据。
    try {
      await bridge.kv.remove(`${MESSAGES_PREFIX}${STRESS_SESSION}`);
      try {
        const indexRaw = await bridge.kv.get(CHARACTER_INDEX_KEY);
        const parsed = JSON.parse(indexRaw || 'null');
        const ids = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ids) ? parsed.ids : []);
        const kept = ids.map(String).filter(id => !id.startsWith(STRESS_PREFIX));
        const revision = Number(parsed && parsed.revision);
        await bridge.kv.set(CHARACTER_INDEX_KEY, JSON.stringify(
          Array.isArray(parsed)
            ? kept
            : { ...(parsed || {}), ids: kept, revision: (Number.isFinite(revision) ? revision : 0) + 1 }
        ));
      } catch (error) {}
      for (let i = 0; i < STRESS_CHARACTER_COUNT; i += 1) {
        try { await bridge.kv.remove(`${CHARACTER_ITEM_PREFIX}${STRESS_PREFIX}char-${i}`); } catch (error) {}
      }
      try {
        const sessionsRaw = await bridge.kv.get(SESSIONS_KEY);
        const parsed = JSON.parse(sessionsRaw || 'null');
        const list = Array.isArray(parsed)
          ? parsed
          : (parsed && Array.isArray(parsed.sessions) ? parsed.sessions : []);
        const kept = list.filter(item => item && !String(item.id).startsWith(STRESS_PREFIX));
        await bridge.kv.set(SESSIONS_KEY, JSON.stringify(
          Array.isArray(parsed) ? kept : { ...(parsed || {}), sessions: kept }
        ));
      } catch (error) {}
      out.cleanedUp = true;
    } catch (error) {
      out.errors.push(`cleanup: ${String((error && error.message) || error).slice(0, 120)}`);
    }

    out.ok = out.bubblesMounted > 0;
  } catch (error) {
    out.errors.push(String((error && error.message) || error).slice(0, 200));
  }
  return out;
}

async function runStressProbe({ bridge, phase = 'seed' }) {
  if (phase === 'measure') return measure({ bridge });
  return seed({ bridge });
}

globalThis.__easychat2RunStressProbe = runStressProbe;
// executeJavaScript 会返回脚本最后一个表达式；函数不可结构化克隆，必须显式收尾。
undefined;