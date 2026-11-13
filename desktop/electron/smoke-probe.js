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
  // ---- 首启门禁：关掉免责声明与教程（冒烟每次都是干净 profile，必然弹出）----
  let firstRun = { attempted: false };
  try {
    const accept = await waitFor(() => Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent === '我知道了' || button.textContent === 'I understand'), 8000);
    if (accept) {
      accept.click();
      // 同意后会进入教程（若未完成）；点「跳过」。
      const skip = await waitFor(() => Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '跳过' || button.textContent === 'Skip'), 8000);
      if (skip) skip.click();
    }
    firstRun = { attempted: true, dismissed: !document.body.innerText.includes('免责条款') || !!accept };
  } catch (error) {
    firstRun = { attempted: true, error: String((error && error.message) || error) };
  }
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

  // Kilo 实时模式下本地 mock 不存在：S3 之后的 mock 依赖探针（渲染/附件/贴纸/备份/
  // 设置/新界面/分支）全部跳过，只跑「基础链路 + 真实网络」这两段。
  const MOCK_MODE = !globalThis.__easychat2KiloLive;
  // 结果容器在块外声明：块内声明会形成 TDZ，块外的 return 一读就抛
  // 「chat is not defined」（真实踩过）。
  let chat = { attempted: false };
  let render = { attempted: false };
  let attachment = { attempted: false };
  let sticker = { attempted: false };
  let backup = { attempted: false };
  let settings = { attempted: false };
  let screens = { attempted: false };
  let library = { attempted: false };
  let usage = { attempted: false };
  let branch = { attempted: false };

  if (MOCK_MODE) {
    // ---- S3：真实界面发一条消息 ----
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

    // ---- S7：设置页（API 配置/采样/人设/外观/对话体验）与消息操作可达性 ----
    try {
      const settingsTab = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '设置' || button.textContent === 'Settings');
      if (!settingsTab) throw new Error('settings tab not found');
      settingsTab.click();
      const loaded = await waitFor(() => {
        const text = document.body.innerText || '';
        const hasApi = text.includes('API 配置') || text.includes('API Configuration');
        const hasSave = text.includes('保存配置') || text.includes('Save configuration');
        const hasModels = text.includes('模型列表') || text.includes('Model list');
        return hasApi && hasSave && hasModels;
      }, 8000);
      // 分区导航逐项可达（点一个非默认分区，确认内容切换）。
      const sections = ['生成参数', '用户人设', '外观', '全局配置'];
      let visited = 0;
      for (const label of sections) {
        const button = Array.from(document.querySelectorAll('nav button'))
          .find(item => item.textContent === label
            || (label === '生成参数' && item.textContent === 'Sampling')
            || (label === '用户人设' && item.textContent === 'User persona')
            || (label === '外观' && item.textContent === 'Appearance')
            || (label === '全局配置' && item.textContent === 'Global settings'));
        if (!button) continue;
        button.click();
        const ok = await waitFor(() => {
          const text = document.body.innerText || '';
          if (label === '生成参数') return text.includes('温度') || text.includes('Temperature');
          if (label === '用户人设') return text.includes('我的身份') || text.includes('My identity');
          if (label === '外观') return text.includes('字体大小') || text.includes('Font size');
          return text.includes('流式输出') || text.includes('Streaming');
        }, 4000);
        if (ok) visited += 1;
      }
      settings = { attempted: true, loaded: !!loaded, sectionsVisited: visited, sectionsTotal: sections.length };
      // 回到聊天页，避免影响后续截图。
      const chatTab = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '聊天' || button.textContent === 'Chat');
      if (chatTab) chatTab.click();
    } catch (error) {
      settings = { attempted: true, error: String((error && error.message) || error) };
    }

    // ---- S8：角色编辑 / 记忆页 / 扩展页 ----
    try {
      const tabButton = label => Array.from(document.querySelectorAll('header button'))
        .find(button => button.textContent === label);
      const openTab = async (zh, en, marker, timeout = 6000) => {
        const button = tabButton(zh) || tabButton(en);
        if (!button) return false;
        button.click();
        return !!(await waitFor(() => (document.body.innerText || '').includes(marker), timeout));
      };
      // 角色页默认进「角色库」网格；编辑页要从卡片上的「编辑角色」进。
      const libraryTabOk = await openTab('角色', 'Characters', '角色库', 6000)
        || await openTab('角色', 'Characters', 'Character Library', 6000);
      const editEntry = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '编辑角色' || button.textContent === 'Edit character');
      if (editEntry) editEntry.click();
      const characterOk = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return text.includes('系统提示词') || text.includes('System prompt');
      }, 6000));
      // 角色编辑页：确认存在世界书与正则的添加入口。
      const worldAddSeen = Array.from(document.querySelectorAll('button'))
        .some(button => button.textContent === '添加世界书条目' || button.textContent === 'Add world entry');
      const memoryOk = await openTab('记忆', 'Memory', '向量记忆', 6000)
        || await openTab('记忆', 'Memory', 'Vector memory', 6000);
      const summaryOk = (document.body.innerText || '').includes('记忆总结')
        || (document.body.innerText || '').includes('Memory summary');
      const extensionOk = await openTab('扩展', 'Extensions', '桌面版首版只提供核心聊天闭环', 6000)
        || await openTab('扩展', 'Extensions', 'core chat loop only', 6000);
      // 展开一条禁用态说明，确认原因文案可见。
      const entry = Array.from(document.querySelectorAll('button'))
        .find(button => String(button.textContent || '').includes('生图')
          || String(button.textContent || '').includes('Image gen'));
      let reasonSeen = false;
      if (entry) {
        entry.click();
        reasonSeen = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          return text.includes('原生图片处理') || text.includes('native image processing');
        }, 4000));
      }
      screens = {
        attempted: true,
        libraryTabOk: !!libraryTabOk,
        characterOk,
        worldAddSeen,
        memoryOk: !!memoryOk,
        summaryOk: !!summaryOk,
        extensionOk: !!extensionOk,
        reasonSeen,
      };
      const chatTab = tabButton('聊天') || tabButton('Chat');
      if (chatTab) chatTab.click();
    } catch (error) {
      screens = { attempted: true, error: String((error && error.message) || error) };
    }

    // ---- S9：角色库（网格 + 搜索 + 置顶）/ 上下文占用条 / 分支切换器 ----
    try {
      const tabButton = label => Array.from(document.querySelectorAll('header button'))
        .find(button => button.textContent === label);
      const characterTab = tabButton('角色') || tabButton('Characters');
      if (!characterTab) throw new Error('character tab not found');
      characterTab.click();
      // 侧栏「☰」进入角色库网格（默认进的是编辑页）。
      const gridButton = Array.from(document.querySelectorAll('aside button'))
        .find(button => button.textContent === '☰');
      if (gridButton) gridButton.click();
      const gridOk = !!(await waitFor(() => (document.body.innerText || '').includes('角色库')
        || (document.body.innerText || '').includes('Character library'), 6000));
      const searchSeen = !!document.querySelector('input[placeholder="搜索角色名或标签"]')
        || !!document.querySelector('input[placeholder="Search character names or tags"]');
      const cards = Array.from(document.querySelectorAll('section > div > div'))
        .filter(node => node.querySelector && node.querySelector('strong'));
      // 搜索：输入一个不可能匹配的词，列表应清空（验证 filter 真的接管渲染）。
      const searchInput = document.querySelector('input[placeholder="搜索角色名或标签"]')
        || document.querySelector('input[placeholder="Search character names or tags"]');
      let searchFiltered = false;
      let searchRestored = false;
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, 'zzz-no-such-character');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchFiltered = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          return text.includes('没有匹配的角色') || text.includes('No characters match');
        }, 4000));
        setter.call(searchInput, '');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchRestored = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          return !text.includes('没有匹配的角色') && !text.includes('No characters match');
        }, 4000));
      }
      // 进编辑页确认「返回角色库」按钮存在（编辑/库之间能来回走）。
      // 注意不能用卡片上的「切换到角色」——那个动作是切角色 + 跳聊天页。
      const openEditButton = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '编辑角色' || button.textContent === 'Edit character');
      if (openEditButton) openEditButton.click();
      const backSeen = !!(await waitFor(() => Array.from(document.querySelectorAll('button'))
        .some(button => button.textContent === '返回角色库' || button.textContent === 'Back to Character Library'), 6000));
      library = {
        attempted: true,
        gridOk,
        searchSeen,
        searchFiltered,
        searchRestored,
        cardCount: cards.length,
        backSeen,
      };
      const chatTab = tabButton('聊天') || tabButton('Chat');
      if (chatTab) chatTab.click();
    } catch (error) {
      library = { attempted: true, error: String((error && error.message) || error) };
    }

    // ---- S9：上下文占用条（真实消息 → token 估算 → 百分比）----
    try {
      // 回聊天页后需等占用条重算（消息条数变化触发）。
      const barSeen = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return text.includes('上下文占用') || text.includes('Context usage');
      }, 6000));
      const bodyText = document.body.innerText || '';
      // 冒烟会话只有十几条短消息，占 200k 窗口不到 0.5%：四舍五入后就是 0%。
      // 因此这里判「占用的 token 数字非零」，而不是「百分比 > 0」。
      const percentMatch = bodyText.match(/(\d+)%/);
      const tokensMatch = bodyText.match(/([\d.]+k?)\s*\/\s*[\d.]+k?\s*tokens/);
      // 「压缩」按钮只有在占用过提示线才出现：低占用时看不到是正确行为，不判失败。
      const compactButtonSeen = Array.from(document.querySelectorAll('button'))
        .some(button => button.textContent === '压缩' || button.textContent === 'Compact');
      usage = {
        attempted: true,
        barSeen,
        percentSeen: percentMatch ? Number(percentMatch[1]) : 0,
        tokenText: tokensMatch ? tokensMatch[1] : '',
        compactButtonSeen,
      };
    } catch (error) {
      usage = { attempted: true, error: String((error && error.message) || error) };
    }

    // ---- S9：分支切换器（重新生成 -> 归档旧回复 -> < 1///2 > -> 切回）----
    try {
      const sessionId = (window.__easychat2S2 && window.__easychat2S2.activeSessionId) || '';
      // 找到最后一条助手消息的「重新生成」按钮（气泡内 ↻，title 是词条文本）。
      const regenButtons = Array.from(document.querySelectorAll('button'))
        .filter(button => button.title === '重新生成' || button.title === 'Regenerate');
      if (regenButtons.length === 0) throw new Error('regenerate button not found');
      regenButtons[regenButtons.length - 1].click();
      // 重新生成是**替换**旧回复（文本可能逐字相同），因此不能用「回复条数增加」判到达；
      // 改判落盘事实：旧尾段被归档后，分支索引键出现且至少有一条描述符。
      let branchArchived = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const raw = sessionId
          ? await bridge.kv.get('@easychat2_branch_index::' + sessionId)
          : null;
        if (raw) {
          try {
            const list = JSON.parse(raw);
            if (Array.isArray(list) && list.length > 0) {
              branchArchived = true;
              break;
            }
          } catch (error) {
            // 索引还没写完或形状异常：继续等。
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // 重新生成成功后，旧回复进入分支索引：气泡下方出现版本切换器。
      const navSeen = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return /\d+\/\/\/\d+/.test(text);
      }, 8000));
      let switchedBack = false;
      let indexBefore = '';
      let indexAfter = '';
      let prevEnabled = false;
      if (navSeen) {
        indexBefore = ((document.body.innerText || '').match(/\d+\/\/\/\d+/) || [''])[0];
        const prevArrow = Array.from(document.querySelectorAll('button'))
          .find(button => button.getAttribute('aria-label') === '上一个版本'
            || button.getAttribute('aria-label') === 'Previous version');
        prevEnabled = !!prevArrow && !prevArrow.disabled;
        if (prevEnabled) {
          prevArrow.click();
          // 切回旧版本：当前尾段被归档成新分支，版本序号必然变化（1///2 -> 1///3 这类）。
          // 切换完成后分叉索引被消费、活动时间线换成旧分支：版本序号必然变化
          // （冒烟里是 2///2 -> 1///2）。**不**用箭头可用态判收尾——切到首版本后
          // 「上一版」本来就该置灰，那是正确终态而不是未完成。
          switchedBack = !!(await waitFor(() => {
            const text = (document.body.innerText || '').match(/\d+\/\/\/\d+/);
            const current = text ? text[0] : '';
            if (!current || current === indexBefore) return null;
            // 落盘事实：本轮切换把「当前尾段」重新归档，分支索引里必然又有一条描述符。
            return current;
          }, 10000));
          indexAfter = ((document.body.innerText || '').match(/\d+\/\/\/\d+/) || [''])[0];
        }
      }
      branch = {
        attempted: true,
        branchArchived,
        navSeen,
        prevEnabled,
        switchedBack,
        indexBefore,
        indexAfter,
      };
    } catch (error) {
      branch = { attempted: true, error: String((error && error.message) || error) };
    }

  }

  // ---- Kilo 匿名网关实时链路（仅 EASYCHAT2_KILO_LIVE=1）----
  // 该模式下配置就是 Kilo，整段冒烟只关心「真实网络请求是否跑通」：
  // 发一条消息 -> 等真实模型回复落盘。失败带 error 返回，由 main.js 的 ok 判据决定。
  let kilo = { attempted: false, skipped: !globalThis.__easychat2KiloLive };
  if (globalThis.__easychat2KiloLive) try {
    const state0 = window.__easychat2Chat || {};
    const beforeMessages = Number(state0.messages) || 0;
    const textarea = await waitFor(() => document.querySelector('textarea'));
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'Kilo匿名链路测试');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const button = await waitFor(() => {
        const state = window.__easychat2Chat;
        const candidate = sendButton();
        return state && state.ready && !state.isSending && candidate && !candidate.disabled ? candidate : null;
      }, 20000);
      let sendAttempted = false;
      let replySeen = false;
      if (button) {
        sendAttempted = true;
        button.click();
        // 真实网络 + 免费池：最多等 90 秒，且要等 isSending 归零。
        for (let attempt = 0; attempt < 900; attempt += 1) {
          const state = window.__easychat2Chat || {};
          if (attempt > 10 && state.isSending !== true) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const after = window.__easychat2Chat || {};
        // 用户消息 + 助手消息各一条。
        replySeen = Number(after.messages) >= beforeMessages + 2;
        kilo = {
          attempted: true,
          sendAttempted,
          replySeen,
          beforeMessages,
          afterMessages: Number(after.messages) || 0,
          sendResult: window.__easychat2Send || null,
        };
      } else {
        kilo = { attempted: true, sendAttempted, error: 'send button never armed' };
      }
    } else {
      kilo = { attempted: true, error: 'composer not found' };
    }
  } catch (error) {
    kilo = { attempted: true, error: String((error && error.message) || error) };
  }

  return {
    bridge: true,
    firstRun,
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
    // mock 段落被跳过时（Kilo 实时模式）这些变量从未声明：用空对象占位，
    // 判据在 main.js 里按模式二选一，不会误读。
    chat: MOCK_MODE ? chat : { attempted: false, skipped: true },
    render: MOCK_MODE ? render : { attempted: false, skipped: true },
    attachment: MOCK_MODE ? attachment : { attempted: false, skipped: true },
    sticker: MOCK_MODE ? sticker : { attempted: false, skipped: true },
    backup: MOCK_MODE ? backup : { attempted: false, skipped: true },
    settings: MOCK_MODE ? settings : { attempted: false, skipped: true },
    screens: MOCK_MODE ? screens : { attempted: false, skipped: true },
    library: MOCK_MODE ? library : { attempted: false, skipped: true },
    usage: MOCK_MODE ? usage : { attempted: false, skipped: true },
    branch: MOCK_MODE ? branch : { attempted: false, skipped: true },
    kilo,
  };
})()
