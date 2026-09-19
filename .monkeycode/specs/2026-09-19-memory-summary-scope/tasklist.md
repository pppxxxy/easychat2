# 记忆总结按会话作用域 任务清单

- [ ] 1. 在 `src/storage.js` 新增 `@easychat2_session_summaries::<sessionId>` 的读写：`getSessionSummaries` / `appendSessionSummary` / `saveSessionSummaries`。
- [ ] 2. 在 `src/storage.js` 的 `deleteSession` 与 `deleteSessions` 中清理对应会话总结键。
- [ ] 3. 在 `src/memorySummary.js` 新增 `countCharacterMemories(sessions, characterId)`（同角色、`preview` 非空、排除群聊）。
- [ ] 4. 修改 `src/memorySummary.js` 的 `applySummary`：接收 `memoryCount`，`>= 2` 时写会话总结并更新边界（不写世界书），否则维持写世界书。
- [ ] 5. 修改 `src/memorySummary.js` 的 `buildMemorySummaryText(character, session)`：合并世界书总结与会话总结；`session` 缺省时仅世界书；空输入返回空串。
- [ ] 6. 在 `src/ChatScreen.js` 的 `runSummarize` 计算并传入 `memoryCount`；`requestReply` 传入当前会话；手动总结提示文案按落点区分。
- [ ] 7. 脚本验证：计数、作用域写入、上下文合并、会话隔离、删除清理。
- [ ] 8. 运行未定义引用检查 `npx eslint --config /tmp/opencode/eslint.check.mjs App.js src/*.js src/*/*.js`，必须无输出。
- [ ] 9. 运行 `npx expo export --platform android` 验证打包通过。
- [ ] 10. 同步 `.monkeycode/docs/INTERFACES.md` 与 `模块/数据与状态.md`。
