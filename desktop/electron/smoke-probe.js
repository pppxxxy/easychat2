// 冒烟探针（由主进程用 webContents.executeJavaScript 注入渲染进程执行）。
//
// S1 链路：window.easychat2 -> kv/fs -> 磁盘。
// S2 链路：AppProvider 挂载 -> 读取角色库/会话 -> 诊断钩子 window.__easychat2S2。
// S3 链路：真实界面输入 -> 点发送 -> 本地 mock 模型流式回复 -> 消息落盘。
(async () => {
  const waitFor = async (read, timeoutMs = 15000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  };
  const replyCount = () => {
    const text = document.body.innerText || '';
    return text.split('桌面流式回复 OK').length - 1;
  };

  const bridge = window.easychat2;
  if (!bridge) return { bridge: false };
  const dir = bridge.app.paths.documentDirectory;
  const key = '@easychat2_smoke_test';
  await bridge.kv.set(key, 'ok');
  const kvValue = await bridge.kv.get(key);
  await bridge.kv.remove(key);
  await bridge.fs.write(dir + 'smoke.txt', 'hello');
  const fsText = await bridge.fs.read(dir + 'smoke.txt', 'utf8');
  const stat = await bridge.fs.stat(dir + 'smoke.txt');
  const sync = bridge.fs.sync.stat(dir + 'smoke.txt');
  const info = await bridge.app.info();

  const artwork = await bridge.fs.stat(dir + 'avatars/default-assistant-avatar.jpg');
  const avatarsList = await bridge.fs.readDir(dir + 'avatars').catch(error => 'ERR:' + (error.code || error.message));
  const s2 = await waitFor(() => window.__easychat2S2);
  const keys = await bridge.kv.keys();
  const hasCharactersKey = keys.includes('@easychat2_character_index');
  const hasSessionsKey = keys.includes('@easychat2_sessions');

  // ---- S3：真实界面发一条消息 ----
  let chat = { attempted: false };
  try {
    const textarea = await waitFor(() => document.querySelector('textarea'));
    const sendButton = () => Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent === '发送' || button.textContent === 'Send');
    // 注意：输入为空时发送按钮**本来就是禁用的**，必须先输入再等它可用。
    if (!textarea) throw new Error('composer not ready');
    const before = replyCount();
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    descriptor.set.call(textarea, '桌面冒烟消息');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // 先等会话消息加载完成（ready=true）：按钮在 ready 之前是禁用的，
    // 这也是真实用户会遇到的状态（加载中不能发）。
    const armedButton = await waitFor(() => {
      const state = window.__easychat2Chat;
      if (!state || !state.ready) return null;
      const button = sendButton();
      return button && !button.disabled ? button : null;
    }, 20000);
    if (!armedButton) throw new Error('send button stayed disabled');
    armedButton.click();
    const moreReplies = await waitFor(() => replyCount() > before, 25000);
    const sendResult = window.__easychat2Send || null;
    const sessionId = (window.__easychat2S2 && window.__easychat2S2.activeSessionId) || '';
    // 落盘是串行队列（design.md 正确性属性 4）：流式结束后稍等片刻再断言，最多等 8s。
    let raw = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      raw = sessionId ? await bridge.kv.get('@easychat2_messages::' + sessionId) : null;
      if (raw && String(raw).includes('桌面流式回复 OK') && String(raw).includes('桌面冒烟消息')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    chat = {
      attempted: true,
      state: window.__easychat2Chat || null,
      submits: window.__easychat2Submit || null,
      sendResult,
      replySeen: !!moreReplies,
      userMessagePersisted: !!raw && String(raw).includes('桌面冒烟消息'),
      replyPersisted: !!raw && String(raw).includes('桌面流式回复 OK'),
      sessionId: !!sessionId,
    };
  } catch (error) {
    chat = { attempted: true, state: window.__easychat2Chat || null, error: String((error && error.message) || error) };
  }

  return {
    bridge: true,
    kv: kvValue,
    fs: fsText,
    exists: !!stat.exists,
    syncExists: !!sync.exists,
    xhr: typeof XMLHttpRequest === 'function',
    version: info && info.version,
    documents: dir,
    artworkExists: !!(artwork && artwork.exists),
    avatarsList,
    s2,
    storage: { hasCharactersKey, hasSessionsKey, keyCount: keys.length },
    chat,
  };
})()
