# 群像卡群聊 任务清单

- [x] 1. 在 `src/context/sessionLibrary.js` 为群聊会话新增 `groupMode`（`'ensemble' | 'turn'`），`normalizeSession` 与 `createGroupSession` 缺省 `'ensemble'`。
- [x] 2. 在 `src/groupChat.js` 新增常量 `ENSEMBLE_MODE` / `TURN_MODE` 与 `buildEnsemblePrompt({ characters, historyMessages, userText, userProfile, globalPresets, profiles, mentions })`。
- [x] 3. 在 `src/groupChat.js` 新增 `parseEnsembleReply(text, characters)`，按「角色名：」分段，兼容未知角色与空输入。
- [x] 4. 在 `src/groupChat.js` 新增 `mergeAdjacentSegments(segments)`（同角色连续段合并）。
- [x] 5. 在 `src/ChatScreen.js` 重构 `requestGroupReply`：抽取现有逐角色逻辑为内部函数；`groupMode === 'ensemble'` 时单次调用并解析，失败/空解析回退逐角色。
- [x] 6. 群像卡模式流式：把累计文本放入单条 pending 消息，解析完成后替换为多条带发言者的消息。
- [x] 7. 保留 `@` 指定：`mentions` 注入群像卡提示词，点名角色优先发言。
- [x] 8. 脚本验证 `parseEnsembleReply`（标准/无空行/旁白/含冒号/未知角色/空）与 `buildEnsemblePrompt`（成员齐全、格式要求、@ 注入）。
- [x] 9. 脚本验证 `groupMode` 规范化与默认值。
- [x] 10. 运行未定义引用检查 `npx eslint --config /tmp/opencode/eslint.check.mjs App.js src/*.js src/*/*.js`，必须无输出。
- [x] 11. 运行 `npx expo export --platform android` 验证打包通过。
- [x] 12. 同步 `.monkeycode/docs/INTERFACES.md` 与 `模块/卡解析与提示管线.md`。
