// 「角色库在别处被改过」的通知缝：MCP 角色卡工具直写存储，React 状态不知道。
//
// 为什么需要这个模块：MCP 的 create_character / edit_character（见
// src/workspace/toolDefs/charactersTools.js）走 storage.saveCharacterLibrary 直接写盘，
// 绕开了 AppContext 的 characters state。后果实测过：卡确实建成了、盘上能读到，
// 但角色页里看不到——必须重启 App 才现身（2026-10-21 实测：盘上 26 张，界面 25 张，
// 差的正是刚建的那张）。用户看到「没建成」就会重复建卡，库里于是堆同名的卡。
//
// 为什么用注册表而不是让写入方直接 import AppContext：AppContext 是 RN 组件，
// 而 workspace/toolDefs 是**纯定义表**（tests/toolsLayering.test.mjs 用加载器炸弹钉住
// 它不许拖进 RN/expo）。两边只能在零依赖的纯模块上会合：AppContext 挂载时注册
// 「重载函数」，写入方写成功后 notify。Node 环境（单测/桥）没人注册 → notify 空转。
//
// 为什么 notify 是同步的：它只是「叫 App 去重读一遍」，不该拖慢工具返回，更不该让
// 一次已经成功的写入因为刷新失败而报错。异步重读的失败由注册方自己吞（见
// AppContext 里 subscribe 处的 .catch）。

const listeners = new Set();

// 注册重载函数，返回退订函数。传入非函数时返回一个空退订，调用方不必判空。
export function subscribeCharacterLibraryChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 通知所有注册方。监听器抛错**一律吞掉**：写入已经落盘成功了，通知失败不能把成功
// 变失败；同理也不能让一个坏监听器挡住后面的监听器。
// 返回实际通知到的监听器数量（测试与诊断用；Node 下通常是 0）。
export function notifyCharacterLibraryChanged(reason = '') {
  let notified = 0;
  for (const listener of Array.from(listeners)) {
    try {
      listener(reason);
      notified += 1;
    } catch (error) {}
  }
  return notified;
}

// 仅测试用：清空注册表，避免用例之间互相串（模块级单例在 node --test 里是共享的）。
export function __resetCharacterLibraryListenersForTests() {
  listeners.clear();
}
