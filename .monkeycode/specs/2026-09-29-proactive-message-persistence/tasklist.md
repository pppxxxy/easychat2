# 需求实施计划：主动消息写入会话

## 阶段 A：原生待写队列

- [ ] A1. `MessageStore` 新增 `PendingMessage` 数据结构与 `pending_messages` 键（需求 1.1）
- [ ] A2. `appendPendingMessage` 实现：追加 + 上限 `MAX_PENDING` 淘汰最旧 + 超期淘汰（需求 4.1、4.2）
- [ ] A3. `loadPendingMessages` / `removePendingMessages(ids)`（需求 1.4）
- [ ] A4. `ProactiveMessageSender.send` 在发通知前调用 `appendPendingMessage`；通知被拒不阻断落库（需求 1.1、2.1）
- [ ] A5. `markSlotSentToday` 语义收敛为「本槽今日已生成」，与「已成功提醒」解耦（需求 2.1）

## 阶段 B：原生 JS 桥

- [ ] B1. `ProactiveMessageModule` 新增 `@ReactMethod consumePendingMessages(promise)`，返回消息数组并清空（需求 1.2、1.4）
- [ ] B2. `src/proactiveMessage.js` 封装 `consumePendingMessages()`（需求 1.2）

## 阶段 C：JS 落库

- [ ] C1. 纯函数 `buildProactiveMessageId(slotId, date)`（需求 1.5）
- [ ] C2. 纯函数 `mergeProactiveMessage(messages, incoming)`：按 id 幂等去重后追加（需求 1.5）
- [ ] C3. 存储/上下文新增 `appendProactiveMessage(sessionId, { id, text, createdAt })`，写入 assistant 消息并复用 `saveMessagesBySession`（需求 1.2）
- [ ] C4. 目标会话解析：复用 `ensureCharacterSession(roleId)`，无会话则建立（需求 3.1、3.2、3.3）
- [ ] C5. `ProactiveMessageBridge` 启动 effect 与 `onOpenRole` 回调中消费队列、写入、刷新会话列表/消息、再跳转（需求 1.2、1.6、2.3）
- [ ] C6. 写入失败重试：失败的 id 下次启动重试；角色已删除则跳过移除（错误处理）

## 阶段 D：检查点

- [ ] D1. `npm run lint` 无输出
- [ ] D2. `npm test` 全绿（新增 id 生成与幂等合并测试）
- [ ] D3. Kotlin 源码断言：发通知前必须 `appendPendingMessage`（测试策略）

## 阶段 E：回归与文档

- [ ] E1. `npx expo export --platform android` 通过
- [ ] E2. `SMOKE_TEST.md` 增加主动消息落库走查（后台到点→打开 App 可见、点通知可见、关闭通知权限仍落库）
- [ ] E3. 同步 `.monkeycode/docs/`（INTERFACES、数据与状态、构建与配置）与 AGENTS.md 的原生模块说明
- [ ] E4. 修订「⏸ 未解历史 bug：主动消息点通知不跳转」条目：本 spec 覆盖了「消息不落库」这一根因；跳转问题若在本 spec 落地后仍存在，才作为独立事件送达 bug 继续排查
