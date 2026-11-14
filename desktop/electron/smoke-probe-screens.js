// 冒烟探针（界面段）：角色编辑 / 记忆页 / 扩展页三块入口的可用性。
//
// 从 smoke-probe.js 外提（那里再次撞到 800 行棘轮）。外提的是**新增的真实检查逻辑**，
// 不是为了凑行数——本段从 S8 起逐步长到 140+ 行，已经不适合继续留在主探针里。
//
// 调用方式与 smoke-probe-group.js / smoke-probe-surface.js 一致：main.js 先注入本模块
// （脚本末尾返回 undefined，避免 executeJavaScript 试图克隆函数），主探针再调用
// globalThis 上的入口。
//
// 判据只写「界面上真的出现了什么」，不猜内部状态：这些段落验的是接线，不是算法。
async function runScreensProbe({ waitFor }) {
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

  // 记忆标签 = 会话列表管理（与手机同定位）；向量记忆/记忆总结在「设置 → 向量记忆」。
  const memoryOk = await openTab('记忆', 'Memory', '编辑', 6000)
    || await openTab('记忆', 'Memory', '全部', 6000);
  const memoryBucketsSeen = ['置顶', '最近 7 天', '更早', 'Pinned', 'Last 7 days', 'Older', '还没有历史对话']
    .some(label => (document.body.innerText || '').includes(label));
  const settingsTabForVector = Array.from(document.querySelectorAll('header button'))
    .find(button => button.textContent === '设置' || button.textContent === 'Settings');
  let vectorOk = false;
  let summaryOk = false;
  if (settingsTabForVector) {
    settingsTabForVector.click();
    const vectorNav = await waitFor(() => Array.from(document.querySelectorAll('nav button'))
      .find(button => button.textContent === '向量记忆' || button.textContent === 'Vector memory'), 6000);
    if (vectorNav) {
      vectorNav.click();
      vectorOk = !!(await waitFor(() => {
        const text = document.body.innerText || '';
        return text.includes('向量记忆') || text.includes('Vector memory');
      }, 4000));
      summaryOk = (document.body.innerText || '').includes('记忆总结')
        || (document.body.innerText || '').includes('Memory summary');
    }
  }

  // S13：扩展页已按手机分组重建（创作 / 日常陪伴 / 内容库 / 小游戏），
  // 不再是「暂不支持」清单。判据换成「分组标题 + 可点入口」。
  const extensionOk = await openTab('扩展', 'Extensions', '日常陪伴', 6000)
    || await openTab('扩展', 'Extensions', 'Companion', 6000);
  // 展开一条「依赖手机系统能力」的说明，确认原因文案可见。
  //
  // 判据更新（S18 之后）：看屏幕**不再是不可用项**（已可截本应用画面），所以原来
  // 找「看屏幕」按钮再等「屏幕捕获」文案的做法必然失败——这条断言在 S18 之后一直是
  // 红的，只是当时我用 `grep '"ok":true'` 校验冒烟，匹配到的是嵌套字段
  // chat.sendResult.ok，把顶层 ok:false 掩盖了。现在改成点「本地模型」并等
  // 「llama.rn」（ASCII，不受编码影响）。
  const entry = Array.from(document.querySelectorAll('button'))
    .find(button => String(button.textContent || '').includes('本地模型')
      || String(button.textContent || '').includes('Local models'));
  let reasonSeen = false;
  if (entry) {
    entry.click();
    reasonSeen = !!(await waitFor(() => {
      const text = document.body.innerText || '';
      return text.includes('llama.rn');
    }, 4000));
  }
  const groupHeaders = ['创作', '日常陪伴', '内容库', '小游戏']
    .filter(label => (document.body.innerText || '').includes(label));
  const groupsSeen = groupHeaders.length === 4;

  // ---- S9：角色库（网格 + 搜索）----
  let library;
  try {
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
  } catch (error) {
    library = { attempted: true, error: String((error && error.message) || error) };
  }

  const chatTab = tabButton('聊天') || tabButton('Chat');
  if (chatTab) chatTab.click();

  return {
    attempted: true,
    libraryTabOk: !!libraryTabOk,
    characterOk,
    worldAddSeen,
    memoryOk: !!memoryOk,
    memoryBucketsSeen,
    vectorOk,
    summaryOk: !!summaryOk,
    extensionOk: !!extensionOk,
    groupsSeen,
    reasonSeen,
    library,
  };
}

globalThis.__easychat2RunScreensProbe = runScreensProbe;
// executeJavaScript 会返回脚本的最后一个表达式；函数不可结构化克隆，必须显式收尾。
undefined;