// 「MCP 建完卡，界面立刻能看到」的常驻桥。
//
// 问题：MCP 的角色卡工具（src/workspace/toolDefs/charactersTools.js）直接写存储，
// 绕开了 AppContext 的 characters state。2026-10-21 实测：盘上 26 张、角色页 25 张，
// 差的正是刚建的那张；用户以为没建成，会重复建卡。
//
// 做法：挂在 AppProvider 内部的常驻组件（与 StartupSession / DiaryStartup 同套路），
// 订阅 characterLibrarySync 的通知，收到就调 refreshCharacters 重读整库。
//
// 为什么不做在 AppContext 里：它已经贴着 800 行棘轮上限（799/800），再塞订阅逻辑
// 必然触发 scripts/guard-structure.mjs。摊成一个只返回 null 的桥，既守住行数，
// 也让「订阅/退订」这段有独立落点。
//
// refreshCharacters 用的是**排队版**（enqueueMutation），和用户在界面上触发的
// 角色更新走同一条队列，避免与本进程内的写操作并发打架。
import { useApp } from '../context/AppContext.js';
import { useCharacterLibrarySync } from '../context/useCharacterLibrarySync.js';

export function CharacterLibrarySyncStartup() {
  const { refreshCharacters } = useApp();
  useCharacterLibrarySync(refreshCharacters);
  // 纯副作用组件：不渲染任何东西。
  return null;
}
