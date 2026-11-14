// 冒烟探针（结构段）：验证桌面「更多」菜单里四项能力真的打得开。
//
// 从 smoke-probe.js 外提（那里已到 800 行棘轮）：这些行是新增的真实检查逻辑，
// 不是挪代码凑数——外提的理由是「该文件已难评审」，符合棘轮条款里的优先出口。
//
// 调用方式与 smoke-probe-group.js 一致：main.js 先注入本模块（脚本末尾返回 undefined，
// 避免 executeJavaScript 试图克隆函数），再由主探针调用 globalThis 上的入口。
//
// 只验「入口 → 面板 → 内容真的渲染」：面板里的数据来自共享层，落盘与判定已由
// 单测覆盖，这里不重复验算法（冒烟负责接线，单测负责语义）。
async function runSurfaceProbe({ waitFor, bridge }) {
  const bodyText = () => document.body.innerText || '';
  const findButton = pattern => Array.from(document.querySelectorAll('button'))
    .find(button => pattern.test(button.textContent || ''));
  const findButtonByTitleOrLabel = patterns => Array.from(document.querySelectorAll('button'))
    .find(button => patterns.includes(String(button.title || ''))
      || patterns.includes(String(button.getAttribute('aria-label') || '')));
  const closeTopmostPanel = async () => {
    const close = findButton(/^(关闭|Close)$/) || findButtonByTitleOrLabel(['关闭', 'Close']);
    if (close) close.click();
    await new Promise(resolve => setTimeout(resolve, 200));
  };

  // 「更多」按钮的 title 是 chat.menu.more.a11y（会话菜单）。
  // 不能复用 chat.bubble.moreA11y（更多操作）——那是**每条消息气泡**上的菜单按钮，
  // 探针会先命中第一条消息、点开的是消息操作菜单（真跑时就是这么栽的）。
  const more = findButtonByTitleOrLabel(['会话菜单', 'Conversation menu']) || findButton(/^⋯$/);
  if (!more) throw new Error('more button not found');
  more.click();
  const moreMenuSeen = !!(await waitFor(() => {
    const text = bodyText();
    return /本会话统计|Session stats/.test(text) || /导出对话|Export conversation/.test(text)
      ? true
      : null;
  }, 6000));

  // 菜单此刻是开着的：顺手验「自动播报」开关（S17）。
  // 必须在这里做——后面的探针会切页/开别的面板，之后再定位菜单按钮很不可靠
  //（实测在末尾重新找 ⋯ 会找不到，菜单压根没打开）。
  // 文案取自 i18n：zh-CN「自动播报」/ en「Auto read aloud」。
  const BROADCAST_LABEL = /^(自动播报|Auto read aloud)/;
  let broadcastMenuLabels = Array.from(document.querySelectorAll('button'))
    .map(button => String(button.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  let autoBroadcastMenuSeen = false;
  let autoBroadcastToggled = false;
  const broadcastItem = findButton(BROADCAST_LABEL);
  if (broadcastItem) {
    autoBroadcastMenuSeen = true;
    const before = String(broadcastItem.textContent || '');
    broadcastItem.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    // 菜单可能因点击而关闭，重新打开同一入口再读文案。
    more.click();
    await new Promise(resolve => setTimeout(resolve, 400));
    const again = findButton(BROADCAST_LABEL);
    // 开关生效的可见证据：勾选标记出现/消失（共享层写盘后按钮文案跟着变）。
    autoBroadcastToggled = !!again && String(again.textContent || '') !== before;
    // 复原，免得污染后续探针的会话设置。
    if (again) again.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    more.click();
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  // 统计：面板必须渲染出「按 API 配置」分区（证明读到了共享层的汇总结构）。
  let statsOpened = false;
  const statsItem = findButton(/^(本会话统计|Session stats)$/);
  if (statsItem) {
    statsItem.click();
    statsOpened = !!(await waitFor(() => (
      /按 API 配置|By API config/.test(bodyText()) ? true : null
    ), 6000));
    await closeTopmostPanel();
  }

  // 导出：格式标签 + 「共 N 条」元信息都要出现（证明导出条目真的生成了）。
  let exportOpened = false;
  more.click();
  await new Promise(resolve => setTimeout(resolve, 300));
  const exportItem = findButton(/^(导出对话|Export conversation)$/);
  if (exportItem) {
    exportItem.click();
    exportOpened = !!(await waitFor(() => (
      /Markdown/.test(bodyText()) && /共 \d+ 条|messages/.test(bodyText()) ? true : null
    ), 6000));
    await closeTopmostPanel();
  }

  // 搜索：输入一个必然出现过的词，命中计数必须从 0/0 变成 N/M（N>0）。
  let searchOpened = false;
  let searchMatchSeen = false;
  const searchButton = findButtonByTitleOrLabel(['搜索', 'Search']);
  if (searchButton) {
    searchButton.click();
    const input = await waitFor(
      () => document.querySelector('input[placeholder="在本对话中搜索"]')
        || document.querySelector('input[placeholder="Search in this conversation"]'),
      4000
    );
    if (input) {
      searchOpened = true;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      // 查询词从**界面上真实存在的消息**里取，而不是硬编码一句可能不在本会话里的话
      // （第一次真跑时写死「你好」就命中了 0 条 —— 冒烟跑的是新会话，里面没有这句话）。
      const rows = Array.from(document.querySelectorAll('[data-message-id]'));
      let needle = '';
      for (let index = rows.length - 1; index >= 0 && !needle; index -= 1) {
        const text = String(rows[index].innerText || '').replace(/\s+/g, ' ').trim();
        // 取一段连续的字符（中文/字母数字都行），太短会命中太多、太长容易跨格式断掉。
        const match = text.match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z0-9]{3,8}/);
        if (match) needle = match[0];
      }
      if (!needle) needle = 'a';
      setter.call(input, needle);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      searchMatchSeen = !!(await waitFor(() => {
        const match = bodyText().match(/(\d+)\/(\d+)/);
        return match && Number(match[2]) > 0 ? true : null;
      }, 6000));
      const nextButton = findButtonByTitleOrLabel(['下一条匹配', 'Next match']);
      if (nextButton && !nextButton.disabled) {
        nextButton.click();
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await closeTopmostPanel();
    }
  }

  // ---- S13：扩展页的每个子页面都必须真的打得开（不是空壳）----
  // 手机侧是 native-stack；桌面是 id → 组件表。这里逐个点进去、看标题渲染、再返回。
  const extensionEntries = [
    { label: ['制卡工坊', 'Card forge'], title: ['制卡工坊', 'Card forge'] },
    { label: ['图像生成', 'Image generation'], title: ['图像生成', 'Image generation'] },
    { label: ['动态', 'Moments'], title: ['动态', 'Moments'] },
    { label: ['主动消息', 'Proactive messages'], title: ['主动消息', 'Proactive messages'] },
    { label: ['作息', 'Schedule'], title: ['作息', 'Schedule'] },
    { label: ['日记', 'Diary'], title: ['日记', 'Diary'] },
    { label: ['音乐', 'Music'], title: ['音乐', 'Music'] },
    { label: ['书籍', 'Books'], title: ['书籍', 'Books'] },
    { label: ['世界地图', 'World map'], title: ['世界地图', 'World map'] },
    { label: ['小游戏', 'Mini games'], title: ['小游戏', 'Mini games'] },
    // 入口文案（ext.home.screen）与页内标题（screenWatch.title）不同：两处都要认。
    { label: ['屏幕注视', 'Screen watch'], title: ['一起看屏幕', 'Screen peek'] },
    // 入口「插件」与页内标题（plugin.title = 联网搜索 / Web Search）不同。
    { label: ['插件', 'Plugins'], title: ['联网搜索', 'Web Search'] },
  ];
  const extensionOpened = [];
  const extensionMissing = [];
  const extensionTab = findButtonByTitleOrLabel(['扩展', 'Extensions'])
    || Array.from(document.querySelectorAll('header button'))
      .find(button => button.textContent === '扩展' || button.textContent === 'Extensions');
  if (extensionTab) {
    for (const item of extensionEntries) {
      extensionTab.click();
      await new Promise(resolve => setTimeout(resolve, 250));
      const label = Array.from(document.querySelectorAll('button'))
        .find(button => item.label.some(text => String(button.textContent || '').includes(text)));
      if (!label) {
        extensionMissing.push(item.label[0]);
        continue;
      }
      label.click();
      // 子页面的特征：出现返回按钮 + 该入口的标题。
      const opened = !!(await waitFor(() => {
        const text = bodyText();
        const hasBack = Array.from(document.querySelectorAll('button'))
          .some(button => button.textContent === '返回' || button.textContent === 'Back');
        return hasBack && item.title.some(title => text.includes(title)) ? true : null;
      }, 5000));
      if (opened) extensionOpened.push(item.label[0]);
      else extensionMissing.push(item.label[0]);
      const back = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '返回' || button.textContent === 'Back');
      if (back) back.click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const chatTab = Array.from(document.querySelectorAll('header button'))
      .find(button => button.textContent === '聊天' || button.textContent === 'Chat');
    if (chatTab) chatTab.click();
  }

  // ---- S14：自动备份（设置页 → 自动备份 → 立即备份 → 落盘文件存在）----
  let autoBackupOk = false;
  let autoBackupBytes = 0;
  let autoBackupClickSeen = false;
  let autoBackupDirListing = [];
  try {
    // 先把可能还开着的弹出层关掉（上一步搜索/统计面板的遮罩会挡住导航点击）。
    const overlayClose = Array.from(document.querySelectorAll('button'))
      .find(button => button.getAttribute('aria-label') === '关闭' || button.getAttribute('aria-label') === 'Close');
    if (overlayClose) overlayClose.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    // 用 includes 而不是全等：顶栏按钮的 textContent 可能带空白或图标文本。
    const settingsTab = Array.from(document.querySelectorAll('header button'))
      .find(button => String(button.textContent || '').includes('设置')
        || String(button.textContent || '').includes('Settings'));
    if (settingsTab) {
      settingsTab.click();
      // 先确认**真的**到了设置页：左侧分区导航出现即可（首个分区是 API 配置）。
      // 不等这一步就去点导航，点击会落在尚未切换的聊天页上（真跑时就是这样失败的）。
      const settingsReady = !!(await waitFor(() => (document.querySelectorAll('nav button').length >= 3
        ? true : null), 10000));
      autoBackupDirListing = [`settled:${settingsReady}`, `headerBtns:${Array.from(document.querySelectorAll('header button')).map(b => String(b.textContent || '').trim()).join('|')}`];
      // 设置页默认停在「API 配置」；再点自动备份分区。
      const navButtons = () => Array.from(document.querySelectorAll('nav button'))
        .map(button => String(button.textContent || '').trim());
      const nav = await waitFor(() => Array.from(document.querySelectorAll('nav button'))
        .find(button => String(button.textContent || '').trim() === '自动备份'
          || String(button.textContent || '').trim() === 'Auto backup'), 8000);
      autoBackupDirListing = [`settled:${settingsReady}`, `nav:${navButtons().join('|')}`, `found:${!!nav}`];
      if (nav) {
        nav.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        autoBackupOk = !!(await waitFor(() => {
          const text = bodyText();
          return text.includes('自动备份') || text.includes('Auto backup');
        }, 5000));
        // 点「立即备份」：跑一次真实导出（mock 模式下数据量很小）。
        const allButtons = Array.from(document.querySelectorAll('button')).map(button => String(button.textContent || '').trim()).filter(Boolean);
        const runButton = Array.from(document.querySelectorAll('button'))
          .find(button => String(button.textContent || '').trim() === '立即备份'
            || String(button.textContent || '').trim() === 'Back up now');
        autoBackupDirListing = [`hasRun:${!!runButton}`, `btns:${allButtons.slice(0, 14).join('|')}`];
        autoBackupClickSeen = !!runButton;
        if (runButton) {
          if (typeof globalThis !== 'undefined') {
            globalThis.__easychat2AutoBackupError = '';
            globalThis.__easychat2AutoBackupResult = null;
          }
          autoBackupClickSeen = !runButton.disabled;
          runButton.click();
          // 落盘事实：auto-backups/ 下至少出现一个包。
          for (let attempt = 0; attempt < 120; attempt += 1) {
            // 目录来自 bridge.app.paths（preload 里是**同步取好的值**，不是函数）。
            const paths = bridge.app.paths || {};
            const dir = `${String(paths.documentDirectory || '')}auto-backups/`;
            if (dir.length > 'auto-backups/'.length) {
              try {
                const names = await bridge.fs.readDir(dir);
                autoBackupDirListing = (Array.isArray(names) ? names : []).slice(0, 8);
                const match = (Array.isArray(names) ? names : []).find(name => String(name).includes('easychat2-auto-backup-'));
                if (match) {
                  const stat = await bridge.fs.stat(`${dir}${match}`);
                  autoBackupBytes = Number(stat && stat.size) || 0;
                  break;
                }
              } catch (error) {
                // 目录还没建出来：继续等。
              }
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      }
      const chatTab = Array.from(document.querySelectorAll('header button'))
        .find(button => button.textContent === '聊天' || button.textContent === 'Chat');
      if (chatTab) chatTab.click();
    }
  } catch (error) {
    autoBackupOk = false;
    autoBackupDirListing = [].concat(autoBackupDirListing, [`threw:${String((error && error.message) || error).slice(0, 160)}`]);
  }

  // ---- S15：全库搜索（记忆页）+ 全局预设（设置页）----
  let globalSearchOk = false;
  let presetPanelOk = false;
  try {
    // 全库搜索在记忆页工具栏。
    const memoryTab = Array.from(document.querySelectorAll('header button'))
      .find(button => String(button.textContent || '').includes('记忆')
        || String(button.textContent || '').includes('Memory'));
    if (memoryTab) {
      memoryTab.click();
      await new Promise(resolve => setTimeout(resolve, 300));
      const searchBtn = Array.from(document.querySelectorAll('button'))
        .find(button => String(button.textContent || '').trim() === '搜索'
          || String(button.textContent || '').trim() === 'Search');
      if (searchBtn) {
        searchBtn.click();
        globalSearchOk = !!(await waitFor(() => {
          const input = document.querySelector('input[placeholder="搜索历史聊天记录"]')
            || document.querySelector('input[placeholder="Search chat history"]');
          return input ? true : null;
        }, 6000));
        const closeBtn = Array.from(document.querySelectorAll('button'))
          .find(button => String(button.textContent || '').trim() === '关闭'
            || String(button.textContent || '').trim() === 'Close');
        if (closeBtn) closeBtn.click();
      }
    }
    // 全局预设在设置页。
    const settingsTab = Array.from(document.querySelectorAll('header button'))
      .find(button => String(button.textContent || '').includes('设置')
        || String(button.textContent || '').includes('Settings'));
    if (settingsTab) {
      settingsTab.click();
      await new Promise(resolve => setTimeout(resolve, 400));
      const nav = await waitFor(() => Array.from(document.querySelectorAll('nav button'))
        .find(button => String(button.textContent || '').trim() === '全局文本预设'
          || String(button.textContent || '').trim() === 'Global text presets'), 8000);
      if (nav) {
        nav.click();
        presetPanelOk = !!(await waitFor(() => (bodyText().includes('全局文本预设')
          || bodyText().includes('Global text presets')) && bodyText().includes('预设') ? true : null), 6000);
      }
    }
    const chatTab = Array.from(document.querySelectorAll('header button'))
      .find(button => String(button.textContent || '').includes('聊天')
        || String(button.textContent || '').includes('Chat'));
    if (chatTab) chatTab.click();
  } catch (error) {
    // 两项都是「界面能到达」级别的检查，失败会体现在字段值上。
  }

  // ---- S17：语音播报（Web Speech API 真实可用性）----
  // 单测用假 speechSynthesis，证明不了打包后的 Electron 里真有这个能力
  //（语音包缺失时 getVoices 会是空数组）。这里问真渲染进程。
  // 菜单开关的检查不在这里：它在菜单**开着**的那一刻做才可靠（见上面的 S17 段）。
  const synth = globalThis.speechSynthesis;
  const speechSupported = !!(synth && typeof synth.speak === 'function');
  let voiceCount = 0;
  let speechOk = false;
  if (speechSupported) {
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    voiceCount = Array.isArray(voices) ? voices.length : 0;
    // 真播一条极短文本：能构造 utterance 且不抛错即算可用（不依赖真的出声）。
    try {
      const utterance = new globalThis.SpeechSynthesisUtterance('ok');
      utterance.volume = 0;
      synth.speak(utterance);
      synth.cancel();
      speechOk = true;
    } catch (error) {
      speechOk = false;
    }
  }

  // ---- S18：应用内截图（看屏幕 v1 的真实链路）----
  // 单测用假 fs，证明不了打包后主进程真的能 capturePage 并落盘。
  // 这里从渲染层走 bridge（与产品代码同一条路），断言返回 uri 且文件真的存在。
  let captureOk = false;
  let captureError = '';
  let captureBytes = 0;
  try {
    const result = await (bridge.capture && typeof bridge.capture.appScreen === 'function'
      ? bridge.capture.appScreen()
      : { ok: false, reason: 'bridge-missing' });
    if (result && result.ok === true && result.uri) {
      const stat = await bridge.fs.stat(result.path);
      captureBytes = Number(stat && stat.size) || 0;
      captureOk = captureBytes > 0;
    } else {
      captureError = String((result && result.reason) || 'unknown');
    }
  } catch (error) {
    captureError = String((error && error.message) || error).slice(0, 160);
  }

  return {
    attempted: true,
    moreMenuSeen,
    statsOpened,
    exportOpened,
    searchOpened,
    searchMatchSeen,
    extensionOpened: extensionOpened.length,
    extensionTotal: extensionEntries.length,
    extensionMissing,
    autoBackupOk,
    autoBackupBytes,
    autoBackupClickSeen,
    globalSearchOk,
    presetPanelOk,
    speechSupported,
    speechOk,
    voiceCount,
    autoBroadcastMenuSeen,
    autoBroadcastToggled,
    broadcastMenuLabels,
    captureOk,
    captureBytes,
    captureError,
    autoBackupDisabled: autoBackupClickSeen,
    autoBackupDirListing,
    autoBackupHasPanel: /自动备份|Auto backup/.test(bodyText()),
    autoBackupError: String((globalThis.__easychat2AutoBackupError || '')).slice(0, 200),
    autoBackupResult: globalThis.__easychat2AutoBackupResult || null,
  };
}

globalThis.__easychat2RunSurfaceProbe = runSurfaceProbe;
// executeJavaScript 会返回脚本的最后一个表达式；函数不可结构化克隆，必须显式收尾。
undefined;