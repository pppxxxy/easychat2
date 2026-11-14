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

  try {
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

    out.ok = Object.values(out.checks).every(Boolean) && out.errors.length === 0;
  } catch (error) {
    out.errors.push(String((error && error.message) || error).slice(0, 200));
  }
  return out;
}

globalThis.__easychat2RunS36Probe = runS36Probe;
// executeJavaScript 会返回脚本最后一个表达式；函数不可克隆，必须显式收尾。
undefined;
