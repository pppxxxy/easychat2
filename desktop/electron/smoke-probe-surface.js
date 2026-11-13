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
async function runSurfaceProbe({ waitFor }) {
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
  };
}

globalThis.__easychat2RunSurfaceProbe = runSurfaceProbe;
// executeJavaScript 会返回脚本的最后一个表达式；函数不可结构化克隆，必须显式收尾。
undefined;