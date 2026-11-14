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
  // 会话由「首次成为当前角色时补建」的 effect 异步创建，而 __easychat2S2 快照写在
  // 另一个 effect 里——直接读一次会拿到 sessions:0 的中间态（实测踩到）。
  // 等会话真正出现再取快照，超时仍为 0 才算失败。
  const s2 = await waitFor(() => {
    const snapshot = window.__easychat2S2;
    if (!snapshot) return null;
    return snapshot.counts && snapshot.counts.sessions >= 1 ? snapshot : null;
  }, 15000) || await waitFor(() => window.__easychat2S2, 1000);
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
  let usage = { attempted: false };
  let branch = { attempted: false };
  let newSession = { attempted: false };
  let groupChat = { attempted: false };
  let surface = { attempted: false };
  let s36 = { attempted: false };

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
    // 入口与手机一致：设置 → 关于 → 「备份与恢复」（顶栏不再单独占一个按钮）。
    try {
      const settingsEntry = Array.from(document.querySelectorAll('header button'))
        .find(button => button.textContent === '设置' || button.textContent === 'Settings');
      if (!settingsEntry) throw new Error('settings tab not found');
      settingsEntry.click();
      const aboutNav = await waitFor(() => Array.from(document.querySelectorAll('nav button'))
        .find(button => button.textContent === '关于' || button.textContent === 'About'), 6000);
      if (aboutNav) aboutNav.click();
      const openButton = await waitFor(() => Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '备份与恢复' || button.textContent === 'Backup & Restore'), 6000);
      if (!openButton) throw new Error('backup entry not found in About');
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
      // 设置页会记住上次的分区（前面的备份探针停在「关于」）：显式切回 API 分区，
      // 否则这里断言的是「关于」卡，永远看不到 API 配置。
      const apiNav = await waitFor(() => Array.from(document.querySelectorAll('nav button'))
        .find(button => button.textContent === 'API 配置' || button.textContent === 'API Configuration'), 6000);
      if (apiNav) apiNav.click();
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
      // 内联配图 + 表情包档位（S21）：此前整节漏掉，开关恒 false、气泡不渲染。
      // 这里只验「入口与三档控件真的在页面上」——写入语义由单测覆盖。
      const experienceNav = Array.from(document.querySelectorAll('nav button'))
        .find(item => item.textContent === '全局配置' || item.textContent === 'Global settings');
      let inlineImageCardSeen = false;
      let stickerControlsSeen = false;
      if (experienceNav) {
        experienceNav.click();
        inlineImageCardSeen = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          // 文案取自 i18n：settings.inlineImage.title =「对话配图」/「Chat Illustrations」。
          return text.includes('对话配图') || text.includes('Chat Illustrations');
        }, 5000));
        stickerControlsSeen = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          // 概率档位与位置是 select，文案来自 settings.sticker.*
          return (text.includes('表情包') || text.includes('Stickers'))
            && (text.includes('概率') || text.includes('Chance'))
            && (text.includes('相对文字') || text.includes('Relative to text'));
        }, 5000));
      }
      // 聊天内工具开关（S27）：共享层早支持，桌面此前没有 UI。
      // 文案取自 i18n：settings.global.chatTools =「聊天内工具（联网搜索）」。
      const chatToolsToggleSeen = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return text.includes('聊天内工具') || text.includes('In-chat tools');
      }, 4000));
      settings = {
        attempted: true,
        loaded: !!loaded,
        sectionsVisited: visited,
        sectionsTotal: sections.length,
        inlineImageCardSeen,
        stickerControlsSeen,
        chatToolsToggleSeen,
      };
      // 回到聊天页，避免影响后续截图。
      const chatTab = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '聊天' || button.textContent === 'Chat');
      if (chatTab) chatTab.click();
    } catch (error) {
      settings = { attempted: true, error: String((error && error.message) || error) };
    }

    // ---- S8 + S13：角色编辑 / 记忆页 / 扩展页 ----
    // 模块见 smoke-probe-screens.js（main.js 已预先注入），理由同群聊与 surface 探针：
    // 主探针已撞到 800 行棘轮，且这段是独立的一组界面检查。
    screens = globalThis.__easychat2RunScreensProbe
      ? await globalThis.__easychat2RunScreensProbe({ waitFor })
      : { attempted: false, skipped: true };


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
      // ---- S11：群聊探针（模块见 smoke-probe-group.js，main.js 已预先注入）----
      groupChat = globalThis.__easychat2RunGroupChatProbe
        ? await globalThis.__easychat2RunGroupChatProbe({ waitFor, sendButton })
        : { attempted: false, skipped: true };

      // 进本段前先清掉可能残留的弹层（未保存确认 / 公告 / 面板）。
      // S37 起角色编辑页有脏表单时会弹「未保存的修改」，探针刚从角色页回来，
      // 不清掉后面点「+」会被遮住。
      for (const label of ['直接离开', '留下编辑', '关闭', 'Close']) {
        const closer = Array.from(document.querySelectorAll('button'))
          .find(button => String(button.textContent || '').trim() === label);
        if (closer && label !== '留下编辑') {
          closer.click();
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      // ---- S12：顶栏「+」新建会话，且新会话**真的发得出消息** ----
      // 修复前的故障：不带开场白建会话 ⇒ greetingSelected=false ⇒ 共享层
      // useChatSend 的闸门 `if (!isGroup && !greetingReady) return false` 静默拦下
      // 每一条消息。所以冒烟不能只数会话条数，必须验到落盘标志位 + 真发一条。
      try {
        const readSessions = async () => {
          const raw = await bridge.kv.get('@easychat2_sessions');
          try {
            const list = JSON.parse(raw || '[]');
            return Array.isArray(list) ? list : [];
          } catch (error) {
            return [];
          }
        };
        const beforeList = await readSessions();
        const beforeCount = beforeList.length;
        const beforeIds = new Set(beforeList.map(item => item && item.id));
        const plus = Array.from(document.querySelectorAll('header button'))
          .find(button => button.textContent === '+');
        if (!plus) throw new Error('plus button not found');
        plus.click();
        const confirm = await waitFor(() => Array.from(document.querySelectorAll('button'))
          .find(button => button.textContent === '新建' || button.textContent === 'New'), 6000);
        if (!confirm) throw new Error('confirm button not found');
        confirm.click();
        // 开场白选择器必须出现 —— 出现了才说明「+」没绕过开场白直接建会话。
        const pickerSeen = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          return /选择开场白|Choose a greeting/.test(text)
            && Array.from(document.querySelectorAll('button'))
              .some(button => button.textContent === '使用此开场白' || button.textContent === 'Use this greeting');
        }, 8000));
        if (pickerSeen) {
          // 选「不使用开场白」这条最难的分支：此时正文为空，仍然必须传 opening 对象，
          // 否则 greetingSelected 又变回 false（老 bug 原样复发）。
          const useButton = Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent === '使用此开场白' || button.textContent === 'Use this greeting');
          if (useButton) useButton.click();
        }
        let afterCount = beforeCount;
        let createdSession = null;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const list = await readSessions();
          afterCount = list.length;
          if (afterCount > beforeCount) {
            createdSession = list.find(item => item && !beforeIds.has(item.id)) || null;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const greetingSelected = !!(createdSession && createdSession.greetingSelected === true);
        // 端到端再验一次「真能发」：只信标志位不够。
        let sendable = false;
        if (createdSession) {
          const textarea = document.querySelector('textarea');
          const state0 = window.__easychat2Chat || {};
          if (textarea && state0.ready && !state0.isSending) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(textarea, '新会话可用性检查');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            const before = Number(state0.messages) || 0;
            const button = await waitFor(() => {
              const candidate = sendButton();
              return candidate && !candidate.disabled ? candidate : null;
            }, 8000);
            if (button) {
              button.click();
              sendable = !!(await waitFor(() => {
                const state = window.__easychat2Chat || {};
                return Number(state.messages) >= before + 2 && state.isSending !== true ? true : null;
              }, 20000));
            }
          }
        }
        newSession = {
          attempted: true,
          beforeCount,
          afterCount,
          created: afterCount > beforeCount,
          pickerSeen,
          greetingSelected,
          sendable,
        };
      } catch (error) {
        newSession = { attempted: true, error: String((error && error.message) || error) };
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

      // ---- S12b：「更多」菜单里的四项能力 ----
      // 模块见 smoke-probe-surface.js（main.js 已预先注入），理由同 S11 的群聊探针：
      // 本文件已到 800 行棘轮，且这段是新增的独立检查逻辑。
      surface = globalThis.__easychat2RunSurfaceProbe
        ? await globalThis.__easychat2RunSurfaceProbe({ waitFor, bridge })
        : { attempted: false, skipped: true };

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

  // ---- S36：清单对照补齐的 7 个入口 ----
  // 放在**全部聊天相关段落之后**：本段会离开聊天页去设置页与扩展页，而
  // usage/branch 探针假设当前在聊天页。S36 自己会切回聊天页收尾。
  s36 = globalThis.__easychat2RunS36Probe
    ? await globalThis.__easychat2RunS36Probe({ waitFor })
    : { attempted: false, skipped: true };

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
    s36: MOCK_MODE ? s36 : { attempted: false, skipped: true },
    // S13 起 library 段并入 screens 探针（见 smoke-probe-screens.js）；
    // main.js 的判据改为读 screens.library。
    library: MOCK_MODE && screens.library ? screens.library : { attempted: false, skipped: true },
    usage: MOCK_MODE ? usage : { attempted: false, skipped: true },
    branch: MOCK_MODE ? branch : { attempted: false, skipped: true },
    newSession: MOCK_MODE ? newSession : { attempted: false, skipped: true },
    groupChat: MOCK_MODE ? groupChat : { attempted: false, skipped: true },
    surface: MOCK_MODE ? surface : { attempted: false, skipped: true },
    kilo,
  };
})()
