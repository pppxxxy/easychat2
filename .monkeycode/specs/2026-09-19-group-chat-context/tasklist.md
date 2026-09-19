# 群聊情境感知 任务清单

- [x] 1. 在 `src/groupChat.js` 新增 `needsProfile(character)`，以 `description` + `personality` 去空白后 `< 30` 字符为「简介不足」判定。
- [x] 2. 在 `src/groupChat.js` 新增 `buildProfilePrompt(character)` 与 `generateMemberProfile(character)`，调用 `sendChatMessage` 生成 1-2 行第三人称人设卡，失败返回 `null`。
- [x] 3. 在 `src/groupChat.js` 新增 `ensureMemberProfiles({ characters, profiles })`，对简介不足且无缓存的成员逐个生成，返回新 `profiles`。
- [x] 4. 在 `src/storage.js` 为群聊会话新增 `memberProfiles` 字段的读写与规范化（缺省为 `{}`）。
- [x] 5. 在 `src/groupChat.js` 新增 `buildGroupContext({ speaker, characters, historyMessages, profiles })`，输出 `[群聊情境]` 文本（多人群聊说明、成员名单含简介与最近发言、最近群聊对话）。
- [x] 6. 在 `src/chatPipeline.js` 的 `buildRequestMessages` 增加可选参数 `groupContext`，非空时追加到 system 内容；单聊传空时行为不变。
- [x] 7. 修改 `src/groupChat.js` 的 `buildGroupRequest`，接收 `profiles` 并计算传入 `groupContext`，保留 `summaryText`/`pluginContext` 透传。
- [x] 8. 在 `src/ChatScreen.js` 的 `requestGroupReply` 中先调用 `ensureMemberProfiles`，将结果写回会话并持久化，再构造请求；确认同轮前述发言已进入历史。
- [x] 9. 脚本验证 `needsProfile`（29/30 边界、空、完整）、`buildGroupContext`（含/空历史、含/无缓存）、`buildGroupRequest` 自我认知，及 `buildRequestMessages` 单聊无回归。
- [x] 10. 运行未定义引用检查 `npx eslint --config /tmp/opencode/eslint.check.mjs App.js src/*.js src/*/*.js`，必须无输出。
- [x] 11. 运行 `npx expo export --platform android` 验证打包通过。
- [x] 12. 同步 `.monkeycode/docs/INTERFACES.md` 与 `模块/卡解析与提示管线.md`。
