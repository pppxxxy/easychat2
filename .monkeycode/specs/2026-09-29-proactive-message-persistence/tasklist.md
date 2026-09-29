# 需求实施计划：主动消息写入会话

## 阶段 A：原生待写队列

- [x] A1. `MessageStore` 新增 `PendingMessage` 数据结构与 `pending_messages` 键（需求 1.1）
- [x] A2. `appendPendingMessage` 实现：追加 + 上限 `MAX_PENDING`(100) 淘汰最旧 + 超期(7天)淘汰（需求 4.1、4.2）
- [x] A3. `loadPendingMessages` / `removePendingMessages(ids)`（需求 1.4）
- [x] A4. `ProactiveMessageSender.send` 在发通知前调用 `appendPendingMessage`；通知被拒不阻断落库（需求 1.1、2.1）
- [x] A5. `markSlotSentToday` 语义收敛为「本槽今日已生成」，与「已成功提醒」解耦（需求 2.1）

## 阶段 B：原生 JS 桥

- [x] B1. `ProactiveMessageModule` 新增 `@ReactMethod consumePendingMessages(promise)` 返回消息数组；**不直接清空**，另有 `ackPendingMessages(ids)` 由 JS 落库成功后调用（比原设计「读取即清空」更稳：写失败可重试，见设计错误处理）。（需求 1.2、1.4）
- [x] B2. `src/proactiveMessage.js` 封装 `consumePendingMessages()` / `ackPendingMessages(ids)`（需求 1.2）

## 阶段 C：JS 落库

- [x] C1. 纯函数 `buildProactiveMessageId(slotId, date)`（需求 1.5）
- [x] C2. 纯函数 `mergeProactiveMessage(messages, incoming)`：按 id 幂等去重后追加（需求 1.5）
- [x] C3. 存储新增 `appendProactiveMessage(characterId, { id, text, createdAt })`：复用/建立目标会话、幂等合并、`saveMessagesBySession` 写盘（需求 1.2、3.1）
- [x] C4. 目标会话解析：存储层按 `characterId` 找单聊会话，无则 `createEmptySession` 建立（需求 3.1、3.2、3.3）
- [x] C5. `ProactiveMessageBridge` 启动 effect 与 `onOpenRole` 回调中消费队列、写入、刷新会话列表/消息、再跳转（需求 1.2、1.6、2.3）
- [x] C6. 写入失败重试：consume 不清空，仅对成功/角色已删除的 id 调 ack；失败 id 下次启动重试（错误处理）

## 阶段 D：检查点

- [x] D1. `npm run lint` 无输出
- [x] D2. `npm test` 全绿：494/494（新增 id 生成、幂等合并、appendProactiveMessage 行为、原生源码断言）
- [x] D3. Kotlin 源码断言：发通知前必须 `appendPendingMessage`（测试策略）
- [x] D4. `npm run test:coverage` ≥ 60% 地板（实际 84.79%）

## 阶段 E：回归与文档

- [x] E1. `npx expo export --platform android` 通过
- [ ] E2. `SMOKE_TEST.md` 增加主动消息落库走查（后台到点→打开 App 可见、点通知可见、关闭通知权限仍落库）
- [x] E3. 同步 `.monkeycode/docs/`（INTERFACES、数据与状态、构建与配置）与 AGENTS.md 的原生模块说明
- [x] E4. 修订「主动消息点通知不跳转」条目：落库落地后，冷启动丢 roleId 的确定性根因已另行修复

## 附加（用户追加需求）

- [x] F1. 消息类型：`DEFAULT`/`CARE`/`GREETING`/`CUSTOM` 四选一，随槽持久化并同步原生
- [x] F2. 原生 `buildSystemPrompt` 按类型组装提示词；问好按触发时段自动选早/中/晚
- [x] F3. 兜底文案 `FallbackMessages.random(messageType)`：关心心情单独一组
- [x] F4. 面板 UI：类型 chips + 「自定义」时显示提示词输入框
