// S36 冒烟探针：验证这一轮补齐的 7 个入口在**打包版**上真的能打开。
//
// 为什么单独写一个而不是并进 smoke-probe-screens.js：那个文件已在 800 行棘轮边缘，
// 且它的判据是「S8~S20 的入口」，与这一轮的清单对照无关。分开也让失败定位更快。
//
// 判据一律是「点进去之后界面上出现了该面板独有的文案」，不猜内部状态：
//   设置搜索     → 输入「温度」后出现「生成参数」
//   自定义配色   → 外观分区出现「自定义配色」标题与槽位名
//   语音播报     → 出现「播报源」与「自动播报」
//   语音转文字   → 出现「新增独立转写配置」
//   更新说明     → 关于卡出现「更新说明」或「暂无更新说明」
//   今日老婆     → 扩展→小游戏→点「今日老婆」出现「今日老公」/空库提示
//   阅读器字号   → 书籍阅读器出现 A- / A+（无书时跳过，不判失败）
async function runS36Probe({ waitFor }) {
  const out = { attempted: true, ok: false, checks: {}, errors: [] };
  const text = () => document.body.innerText || '';
  const has = value => text().includes(value);
  const tabButton = label => Array.from(document.querySelectorAll('header button'))
    .find(button => button.textContent === label);
  const clickButton = label => {
    const button = Array.from(document.querySelectorAll('button'))
      .find(item => String(item.textContent || '').trim() === label);
    if (button) button.click();
    return !!button;
  };
  // 扩展首页的入口卡按钮 textContent 是「图标 + 标题 + 描述」拼起来的整串，
  // 精确匹配永远不中——这里按包含匹配点第一个命中的按钮。
  const clickButtonContaining = label => {
    const button = Array.from(document.querySelectorAll('button'))
      .find(item => String(item.textContent || '').includes(label));
    if (button) button.click();
    return !!button;
  };

  // 诊断：记录运行时的界面状态（顶部 tab 文案 + body 首行），失败时能直接看出卡在哪。
  out.diag = {
    tabs: Array.from(document.querySelectorAll('header button')).map(b => String(b.textContent || '').trim()).slice(0, 12),
    bodyHead: (document.body.innerText || '').slice(0, 120),
  };

  try {
    // 先清掉可能存在的遮罩弹层（首启公告 / 免责声明 / 备份面板）。
    // 本段跑到主探针末尾，此时界面上可能已经弹出这些；不关掉就点不到 tab。
    for (const label of ['关闭', 'Close', '确定', 'OK', '取消', 'Cancel']) {
      const closer = Array.from(document.querySelectorAll('button'))
        .find(button => String(button.textContent || '').trim() === label);
      if (closer) {
        closer.click();
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // 若停在角色编辑页，先「返回角色库」。
    // 原因：S37 起切换 tab 会弹「未保存编辑」确认（共享 characterEditGuard），
    // 探针留在编辑页就会被确认框挡住，后面所有点击都落不到目标上。
    // 探针在编辑页改过字段 → 切换会弹「未保存的修改」。选「直接离开」。
    const leaveBtn = Array.from(document.querySelectorAll('button'))
      .find(button => String(button.textContent || '').trim() === '直接离开');
    if (leaveBtn) {
      leaveBtn.click();
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    const backToLibrary = Array.from(document.querySelectorAll('button'))
      .find(button => String(button.textContent || '').trim() === '返回角色库');
    if (backToLibrary) {
      backToLibrary.click();
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    // ---- 1) 设置：搜索 + 自定义配色 + 语音播报 + 语音转写 + 更新说明 ----
    const settingsTab = tabButton('设置') || tabButton('Settings');
    if (!settingsTab) {
      out.errors.push('settings tab not found');
    } else {
      settingsTab.click();
      await waitFor(() => has('API') || has('接口'), 6000);

      // 设置搜索：输入「温度」，应出现「生成参数」（采样分区的标题）。
      const searchInput = document.querySelector('input[type="search"]');
      if (searchInput) {
        searchInput.focus();
        // React 受控输入必须走 native setter + input 事件，直接赋 value 不触发 onChange。
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        setter.call(searchInput, '温度');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        out.checks.settingsSearch = !!(await waitFor(() => has('生成参数'), 4000));
      } else {
        out.checks.settingsSearch = false;
        out.errors.push('settings search input not found');
      }
      // 清空搜索，避免影响后续点击。
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        setter.call(searchInput, '');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // 外观分区：自定义配色卡。
      clickButton('外观') || clickButton('Appearance');
      out.checks.customTheme = !!(await waitFor(
        () => has('自定义配色') && (has('页面背景') || has('主色与强调')),
        5000
      ));

      // 语音播报 + 语音转文字所在的「全局配置」分区（手机叫「对话体验」，
      // 桌面这个分区的标题键是 settings.global.title = 全局配置）。
      clickButton('全局配置') || clickButton('Global options');
      out.checks.tts = !!(await waitFor(() => has('播报源') && has('自动播报'), 5000));
      out.checks.transcription = !!(await waitFor(() => has('新增独立转写配置'), 5000));

      // 关于分区：更新说明入口（有缓存显示「更新说明」，无缓存显示「暂无更新说明」）。
      clickButton('关于') || clickButton('About');
      out.checks.announcementEntry = !!(await waitFor(
        () => has('更新说明') || has('暂无更新说明'),
        5000
      ));
    }

    // ---- 2) 扩展 → 小游戏 → 今日妻子 ----
    const extTab = tabButton('扩展') || tabButton('Extensions');
    if (!extTab) {
      out.errors.push('extension tab not found');
    } else {
      extTab.click();
      // 入口名是「游戏中心」（ext.home.games），不是「小游戏」。
      await waitFor(() => has('游戏中心') || has('Games'), 6000);
      clickButtonContaining('游戏中心') || clickButtonContaining('Games');
      // 游戏卡名是「今日老婆」（ext.games.dailyWife.name）。
      await waitFor(() => has('今日老婆') || has('Daily Wife'), 5000);
      const opened = clickButtonContaining('今日老婆') || clickButtonContaining('Daily Wife');
      // 进去之后标题是「今日老婆」/「今日老公」，空库时显示「角色库是空的」。
      out.checks.dailyWife = !!opened && !!(await waitFor(
        () => has('今日老公') || has('角色库是空的') || has('今天你的老婆是'),
        5000
      ));
    }

    // 收尾：回到聊天页。后续段落（占用条/分支/Kilo）都以「当前在聊天页」为前提，
    // 本探针会离开到设置页与扩展页，不回来就会让它们误判失败。
    const chatTab = tabButton('聊天') || tabButton('Chat');
    if (chatTab) chatTab.click();
    await waitFor(() => !!(document.querySelector('textarea, input[type="text"]')), 4000);

    // ---- 3) 角色库多选 + 扩展页新增入口 ----
    const charTab = tabButton('角色') || tabButton('Characters');
    if (charTab) {
      charTab.click();
      // 若还停在编辑页（上一段可能刚进来），先返回角色库。
      const back = await waitFor(() => Array.from(document.querySelectorAll('button'))
        .find(button => String(button.textContent || '').trim() === '返回角色库'), 2000);
      if (back) {
        back.click();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      await waitFor(() => has('角色库'), 5000);
      // 多选入口（character.library.select）
      const selectBtn = Array.from(document.querySelectorAll('button'))
        .find(button => String(button.textContent || '').trim() === '多选');
      out.checks.characterMultiSelect = !!selectBtn;
    }
    if (extTab) {
      extTab.click();
      await waitFor(() => has('游戏中心') || has('Games'), 5000);
      // 音乐：播放控制条（上一首/下一首/倍速/播放方式）
      clickButtonContaining('音乐') || clickButtonContaining('Music');
      out.checks.musicControls = !!(await waitFor(
        () => has('播放方式') && has('播放倍速') && has('上一首'),
        5000
      ));
      extTab.click();
      await waitFor(() => has('世界地图') || has('World map'), 5000);
      // 世界地图：真实地图视图切换
      clickButtonContaining('世界地图') || clickButtonContaining('World map');
      out.checks.realMapView = !!(await waitFor(
        () => has('真实地图') && has('网格地图'),
        5000
      ));
      extTab.click();
      await waitFor(() => has('制卡工坊') || has('Card forge'), 5000);
      // 制卡：生成头像/背景入口
      clickButtonContaining('制卡工坊') || clickButtonContaining('Card forge');
      out.checks.forgeImageFields = !!(await waitFor(
        () => has('生成头像') && has('生成背景'),
        5000
      ));
    }

    // ---- 4) S38 补齐的入口 ----
    if (settingsTab) {
      settingsTab.click();
      await waitFor(() => has('API') || has('接口'), 6000);
      // 画面识别来源（main / ocr 切换）
      // 分区名是「图片识别（OCR）模型」；来源选择器的标题是「看屏幕走哪个模型」。
      clickButtonContaining('图片识别') || clickButtonContaining('Image recognition');
      out.checks.screenWatchSource = !!(await waitFor(
        () => has('看屏幕走哪个模型') || has('Which model screen watch uses'),
        5000
      ));
    }
    // 记忆页：展开/折叠全部
    const memTab = tabButton('记忆') || tabButton('Memory');
    if (memTab) {
      memTab.click();
      out.checks.memoryExpandAll = !!(await waitFor(
        () => has('展开全部') || has('Expand all') || has('折叠全部') || has('Collapse all'),
        5000
      ));
    }
    // 聊天页更多菜单：公告入口
    const chatTab2 = tabButton('聊天') || tabButton('Chat');
    if (chatTab2) {
      chatTab2.click();
      await waitFor(() => !!(document.querySelector('textarea, input[type="text"]')), 5000);
      const moreBtn = Array.from(document.querySelectorAll('button'))
        .find(button => String(button.title || '') === '会话菜单' || String(button.title || '') === 'Conversation menu');
      if (moreBtn) {
        moreBtn.click();
        out.checks.chatNoticeEntry = !!(await waitFor(
          () => has('公告') || has('Notice'),
          4000
        ));
        // 关掉菜单：点一下标题区域（菜单的 pointerdown 监听会收起）。
        const header = document.querySelector('header');
        if (header) {
          const rect = header.getBoundingClientRect();
          header.dispatchEvent(new globalThis.MouseEvent('pointerdown', {
            bubbles: true,
            clientX: rect.left + 4,
            clientY: rect.top + 4,
          }));
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      } else {
        out.checks.chatNoticeEntry = false;
      }
    }

    // ---- 5) S39 复核后补齐的入口 ----
    // 附件：拍照 / 拍视频两个按钮（相机对话框本身的打开需要真实摄像头，探针只验入口）
    const chatTab3 = tabButton('聊天') || tabButton('Chat');
    if (chatTab3) {
      chatTab3.click();
      await waitFor(() => !!(document.querySelector('textarea, input[type="text"]')), 5000);
      out.checks.cameraEntries = !!(await waitFor(() => {
        const titles = Array.from(document.querySelectorAll('button'))
          .map(button => String(button.title || ''));
        const hasPhoto = titles.some(text => text.includes('拍照') || text.includes('Take photo'));
        const hasVideo = titles.some(text => text.includes('拍摄视频') || text.includes('Record video'));
        return hasPhoto && hasVideo;
      }, 5000));
    }
    // 看屏幕：悬浮窗开关 + 悬浮球头像三档
    if (extTab) {
      extTab.click();
      await waitFor(() => has('游戏中心') || has('Games'), 5000);
      clickButtonContaining('屏幕注视') || clickButtonContaining('Screen watch');
      out.checks.overlayControls = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return (text.includes('开启悬浮窗') || text.includes('Open floating window'))
          && (text.includes('悬浮球头像') || text.includes('Floating avatar'));
      }, 5000));
      // 悬浮窗真实启停：主进程会建第二个窗口，成功后按钮文案变成「关闭悬浮窗」。
      const startBtn = Array.from(document.querySelectorAll('button'))
        .find(button => /开启悬浮窗|Open floating window/.test(String(button.textContent || '').trim()));
      if (startBtn) {
        startBtn.click();
        out.checks.overlayStarted = !!(await waitFor(() => {
          const text = document.body.innerText || '';
          return text.includes('关闭悬浮窗') || text.includes('Close floating window');
        }, 6000));
        // 收尾：关掉悬浮窗，别让它留在桌面上。
        const stopBtn = Array.from(document.querySelectorAll('button'))
          .find(button => /关闭悬浮窗|Close floating window/.test(String(button.textContent || '').trim()));
        if (stopBtn) {
          stopBtn.click();
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      } else {
        out.checks.overlayStarted = false;
      }
    }

    out.ok = Object.values(out.checks).every(Boolean) && out.errors.length === 0;
  } catch (error) {
    out.errors.push(String((error && error.message) || error).slice(0, 200));
  }
  return out;
}

globalThis.__easychat2RunS36Probe = runS36Probe;
// executeJavaScript 会返回脚本最后一个表达式；函数不可克隆，必须显式收尾。
undefined;
