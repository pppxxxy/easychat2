// 群聊冒烟探针（模块）：由 smoke-probe.js 调用，显式传入它需要的三样东西。
//
// 为什么不是「拼接进主探针的 script 字符串」：拼接会让本文件依赖外层的 waitFor /
// sendButton，ESLint 会把它们判成未定义，而 no-undef 豁免清单只允许变短。
// 改成带参数的 IIFE 后它是自洽模块，主探针只负责调用与收结果。
//
// 返回 { attempted, opened, created, sent, replySeen, speakerSeen }。
async function runGroupChatProbe({ waitFor, sendButton }) {
// ---- S11：群聊（创建 2 人群 -> 发消息 -> 至少一条带发言人的回复）----
try {
  const tabButton = label => Array.from(document.querySelectorAll('header button'))
    .find(button => button.textContent === label);
  // 先确保有两个角色可选（冒烟初始只有一个；用角色库 + 新建一个）。
  const characterTab = tabButton('角色') || tabButton('Characters');
  if (characterTab) characterTab.click();
  const addButton = await waitFor(() => Array.from(document.querySelectorAll('aside button'))
    .find(button => button.textContent === '+'), 6000);
  if (addButton) {
    addButton.click();
    // 新建后进入编辑页：改名后保存，凑出第二个角色。
    const nameInput = await waitFor(() => Array.from(document.querySelectorAll('input'))
      .find(input => input.type === 'text' && input.value === 'New Character'), 6000);
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, '群聊成员二');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const save = await waitFor(() => Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '保存' || button.textContent === 'Save'), 6000);
      if (save) { save.click(); await new Promise(r => setTimeout(r, 300)); }
      // 关掉保存成功的提示。
      const ok = await waitFor(() => Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '确定' || button.textContent === 'OK'), 4000);
      if (ok) ok.click();
    }
  }
  // 进记忆页 -> 新建群聊。
  // 上面刚在角色编辑页改过名字：S37 起切 tab 会弹「未保存的修改」确认框，
  // 必须点「直接离开」才会真的切过去（拦截时 setView 不会执行）。
  const memoryTab = tabButton('记忆') || tabButton('Memory');
  if (memoryTab) memoryTab.click();
  // 弹框在点击之后才出现，所以这里等它。
  const leave = await waitFor(() => Array.from(document.querySelectorAll('button'))
    .find(button => String(button.textContent || '').trim() === '直接离开'), 2000);
  if (leave) {
    leave.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    // 点「直接离开」后若没自动切页，再点一次目标 tab。
    if (memoryTab) memoryTab.click();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const openGroup = await waitFor(() => Array.from(document.querySelectorAll('button'))
    .find(button => button.textContent === '创建群聊' || button.textContent === 'Create group'), 6000);
  let created = false;
  let sent = false;
  let replySeen = false;
  let speakerSeen = false;
  if (openGroup) {
    openGroup.click();
    const boxes = await waitFor(() => {
      const list = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      return list.length >= 2 ? list : null;
    }, 6000);
    if (boxes) {
      boxes[0].click();
      boxes[1].click();
      const create = Array.from(document.querySelectorAll('button'))
        .find(button => button.textContent === '创建' || button.textContent === 'Create');
      if (create && !create.disabled) {
        create.click();
        // 创建成功后自动进聊天页（会话数与群会话关键字都要出现）。
        created = !!(await waitFor(() => {
          const raw = window.__easychat2S2 || {};
          const sessions = raw.counts ? raw.counts.sessions : 0;
          return sessions >= 3 ? true : null;
        }, 8000));
      }
    }
  }
  if (created) {
    const textarea = await waitFor(() => document.querySelector('textarea'));
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '群聊冒烟消息');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const send = await waitFor(() => {
        const button = sendButton();
        const state = window.__easychat2Chat;
        return state && state.ready && !state.isSending && button && !button.disabled ? button : null;
      }, 20000);
      if (send) {
        send.click();
        sent = true;
        replySeen = !!(await waitFor(() => (document.body.innerText || '').includes('群聊成员回复 OK')
          || (document.body.innerText || '').includes('桌面流式回复 OK'), 30000));
        // 群聊回复必须带发言人名字（speakerName 会在气泡上方显示）。
        speakerSeen = ['群聊成员二', 'EasyChat2 助手'].some(name => (document.body.innerText || '').includes(name));
      }
    }
  }
  return {
    attempted: true,
    opened: !!openGroup,
    created,
    sent,
    replySeen,
    speakerSeen,
    // 诊断：找不到「创建群聊」时，看看当时在哪个页面、有哪些按钮。
    diag: {
      bodyHead: (document.body.innerText || '').slice(0, 160),
      buttons: Array.from(document.querySelectorAll('button'))
        .map(button => String(button.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 24),
    },
  };
} catch (error) {
  return { attempted: true, error: String((error && error.message) || error) };
}


}

// 主探针通过 globalThis 调用：两段脚本各自 executeJavaScript，作用域不共享。
globalThis.__easychat2RunGroupChatProbe = runGroupChatProbe;
// 结尾必须是 undefined：executeJavaScript 会把这个脚本**最后一个表达式的值**回传主进程，
// 而函数无法结构化克隆（报 "An object could not be cloned."，实测踩到）。
undefined;
