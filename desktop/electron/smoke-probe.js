// 冒烟探针（由主进程用 webContents.executeJavaScript 注入渲染进程执行）。
//
// S1 链路：window.easychat2 -> kv/fs -> 磁盘。
// S2 链路：AppProvider 挂载 -> 读取角色库/会话 -> 诊断钩子 window.__easychat2S2。
// S3 链路：真实界面输入 -> 点发送 -> 本地 mock 模型流式回复 -> 消息落盘。
// S4 链路：Markdown 排版、富 HTML 沙箱 iframe（样式/折叠/脚本被禁/命令按钮桥接）。
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
  const sendButton = () => Array.from(document.querySelectorAll('button'))
    .find(button => button.textContent === '发送' || button.textContent === 'Send');
  const setTextareaValue = (textarea, value) => {
    // 必须走原生 setter，React 的受控输入才会收到这次变更。
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    descriptor.set.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const sendMessage = async (text, waitForResult, timeoutMs = 25000) => {
    const textarea = await waitFor(() => document.querySelector('textarea'));
    if (!textarea) throw new Error('composer not ready');
    setTextareaValue(textarea, text);
    // 输入为空时发送按钮本来就是禁用的；先输入再等它可用，且要等上一轮发送结束。
    const armedButton = await waitFor(() => {
      const state = window.__easychat2Chat;
      if (!state || !state.ready || state.isSending) return null;
      const button = sendButton();
      return button && !button.disabled ? button : null;
    }, 20000);
    if (!armedButton) throw new Error('send button stayed disabled');
    armedButton.click();
    return waitFor(waitForResult, timeoutMs);
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
    const before = replyCount();
    await sendMessage('桌面冒烟消息', () => replyCount() > before);
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
      replySeen: !!(raw && String(raw).includes('桌面流式回复 OK')),
      userMessagePersisted: !!raw && String(raw).includes('桌面冒烟消息'),
      replyPersisted: !!raw && String(raw).includes('桌面流式回复 OK'),
      sessionId: !!sessionId,
    };
  } catch (error) {
    chat = { attempted: true, state: window.__easychat2Chat || null, error: String((error && error.message) || error) };
  }

  // ---- S4：渲染验收 ----
  let render = { attempted: false };
  try {
    const markdown = await sendMessage('渲染测试', () => {
      const strong = document.querySelector('.ec-md strong');
      const code = document.querySelector('.ec-md pre code');
      if (!strong || !code) return null;
      return { strong: strong.textContent, code: code.textContent };
    });
    const frame = await sendMessage('富HTML测试', () => {
      const candidates = Array.from(document.querySelectorAll('iframe[sandbox]'));
      for (const candidate of candidates) {
        try {
          if (candidate.contentDocument && candidate.contentDocument.getElementById('smoke-card')) return candidate;
        } catch (error) {
          // 拿不到 contentDocument 说明沙箱/同源策略异常，继续找下一张。
        }
      }
      return null;
    });
    let cardBackground = '';
    let scriptTags = -1;
    let pwned = true;
    let detailsSeen = false;
    let frameHeight = 0;
    let frameBodyHeight = 0;
    let commandBridged = false;
    if (frame) {
      const doc = frame.contentDocument;
      const card = doc.getElementById('smoke-card');
      detailsSeen = !!doc.getElementById('smoke-details');
      scriptTags = doc.querySelectorAll('script').length;
      try {
        cardBackground = frame.contentWindow.getComputedStyle(card).backgroundColor;
        pwned = frame.contentWindow.__smokePwned !== undefined;
      } catch (error) {
        cardBackground = '';
      }
      frameHeight = Math.round(frame.getBoundingClientRect().height);
      const button = doc.getElementById('smoke-button');
      if (button) button.click();
      commandBridged = !!(await waitFor(() => {
        const textarea = document.querySelector('textarea');
        return textarea && textarea.value === '卡片命令';
      }, 3000));
      // 高度是 rAF + 延迟采样更新的：等一瞬间再量，否则拿到的是初始占位高度。
      await new Promise(resolve => setTimeout(resolve, 900));
      frameHeight = Math.round(frame.getBoundingClientRect().height);
      frameBodyHeight = doc.body ? doc.body.scrollHeight : 0;
    }
    const sessionId = (window.__easychat2S2 && window.__easychat2S2.activeSessionId) || '';
    let raw = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      raw = sessionId ? await bridge.kv.get('@easychat2_messages::' + sessionId) : null;
      if (raw && String(raw).includes('富 HTML OK')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    render = {
      attempted: true,
      markdownSeen: !!markdown,
      markdownStrong: markdown ? markdown.strong : '',
      markdownCode: markdown ? markdown.code : '',
      richHtmlSeen: !!frame,
      cardStyled: /rgb\(18,\s*52,\s*86\)/.test(cardBackground),
      cardBackground,
      detailsSeen,
      scriptBlocked: scriptTags === 0 && pwned === false,
      scriptTags,
      frameHeight,
      frameBodyHeight,
      commandBridged,
      richHtmlPersisted: !!raw && String(raw).includes('富 HTML OK'),
      state: window.__easychat2Chat || null,
    };
  } catch (error) {
    render = { attempted: true, error: String((error && error.message) || error) };
  }

  // ---- S4b：附件（拖入 -> 校验 -> 落盘 -> 发送） ----
  let attachment = { attempted: false };
  try {
    const beforeReply = replyCount();
    const fileSize = await (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 36;
      const context = canvas.getContext('2d');
      context.fillStyle = '#3355ff';
      context.fillRect(0, 0, 48, 36);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'smoke-drop.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.querySelector('textarea');
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
      return file.size;
    })();
    const chip = await waitFor(() => {
      const state = window.__easychat2Chat;
      if (!state || state.attachments < 1) return null;
      return document.body.innerText.includes('smoke-drop.png') ? state : null;
    }, 10000);
    const armedButton = await waitFor(() => {
      const state = window.__easychat2Chat;
      if (!state || state.attachments < 1 || state.isSending) return null;
      const button = sendButton();
      return button && !button.disabled ? button : null;
    }, 10000);
    if (armedButton) armedButton.click();
    const replied = await waitFor(() => replyCount() > beforeReply, 25000);
    const sessionId = (window.__easychat2S2 && window.__easychat2S2.activeSessionId) || '';
    let raw = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      raw = sessionId ? await bridge.kv.get('@easychat2_messages::' + sessionId) : null;
      if (raw && String(raw).includes('smoke-drop.png')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    attachment = {
      attempted: true,
      fileSize,
      chipSeen: !!chip,
      replySeen: !!replied,
      persisted: !!raw
        && String(raw).includes('smoke-drop.png')
        && String(raw).includes('chat-images/')
        && String(raw).includes('"kind":"image"'),
      state: window.__easychat2Chat || null,
    };
  } catch (error) {
    attachment = { attempted: true, error: String((error && error.message) || error) };
  }

  // ---- S4b：表情包（面板加载 -> 点选发送 -> 落盘） ----
  let sticker = { attempted: false };
  try {
    const before = replyCount();
    const openButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.title === '表情包' || button.title === 'Stickers');
    if (!openButton) throw new Error('sticker toggle not found');
    openButton.click();
    const tile = await waitFor(() => Array.from(document.querySelectorAll('button'))
      .find(button => String(button.title || '').includes('SmokeSticker')), 8000);
    if (!tile) throw new Error('sticker tile not found');
    tile.click();
    const replied = await waitFor(() => replyCount() > before, 25000);
    const sessionId = (window.__easychat2S2 && window.__easychat2S2.activeSessionId) || '';
    let raw = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      raw = sessionId ? await bridge.kv.get('@easychat2_messages::' + sessionId) : null;
      if (raw && String(raw).includes('SmokeSticker')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    sticker = {
      attempted: true,
      tileSeen: !!tile,
      replySeen: !!replied,
      persisted: !!raw
        && String(raw).includes('"kind":"sticker"')
        && String(raw).includes('SmokeSticker'),
      state: window.__easychat2Chat || null,
    };
  } catch (error) {
    sticker = { attempted: true, error: String((error && error.message) || error) };
  }

  // ---- S5：备份面板可见性（导出/恢复真正执行需要原生对话框，交给集成测试） ----
  let backup = { attempted: false };
  try {
    const openButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent === '备份与恢复' || button.textContent === 'Backup & Restore');
    if (!openButton) throw new Error('backup button not found');
    openButton.click();
    const panelSeen = await waitFor(() => {
      const text = document.body.innerText || '';
      const hasExport = text.includes('导出备份') || text.includes('Export backup');
      const hasImport = text.includes('合并恢复') || text.includes('Merge restore');
      const hasCard = text.includes('导出 PNG') || text.includes('Export PNG');
      return hasExport && hasImport && hasCard;
    }, 5000);
    backup = { attempted: true, panelSeen: !!panelSeen };
    const closeButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.title === '关闭' || button.title === 'Close');
    if (closeButton) closeButton.click();
  } catch (error) {
    backup = { attempted: true, error: String((error && error.message) || error) };
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
    render,
    attachment,
    sticker,
    backup,
  };
})()
