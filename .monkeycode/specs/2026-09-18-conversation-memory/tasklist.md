# 需求实施计划

- [x] 1. 扩展 storage.js 支持会话模型与旧数据迁移
  - [x] 1.1 新增会话存储键与默认值：定义 `@easychat2_sessions`、`@easychat2_active_session`，会话消息键 `@easychat2_messages::<sessionId>`（需求 1.1、1.2、1.4、1.5；设计「数据模型」）
  - [x] 1.2 实现会话元数据纯函数：normalize、排序（置顶优先、更新时间倒序）、摘要生成（需求 1.5、2.4、2.5）
  - [x] 1.3 实现 `getSessions` / `saveSessions` / `getActiveSessionId` / `setActiveSessionId`（需求 1.2、1.5）
  - [x] 1.4 实现 `startNewSession(characterId)`：清理空会话、新建空会话并设为当前（需求 7.1、7.2、7.4）
  - [x] 1.5 实现 `getMessagesBySession` / `saveMessagesBySession`：按会话键读写并过滤 `pending`（需求 1.3、1.4、2.2）
  - [x] 1.6 实现 `cloneSession(sessionId)`：复制元数据与消息、消息标识重新生成、`updatedAt` 取当前、未置顶（需求 4.1、4.2、4.4）
  - [x] 1.7 实现 `deleteSession(sessionId)`：移除元数据与消息；删除当前会话时新建空会话（需求 5.1、5.2、5.3）
  - [x] 1.8 实现 `migrateLegacyMessages(characters)`：旧键迁移为历史会话，幂等，保留内容与顺序（需求 8.1、8.2、8.3）
  - [ ]* 1.9 属性测试：会话排序稳定、克隆独立性、迁移幂等（设计「正确性属性」1、2、6）

- [x] 2. 改造 AppContext 为会话状态
  - [x] 2.1 建立会话状态与派生值：`sessions`、`activeSessionId`，沿用 `characterRef`/`loadedRef` 与 `mutationRef` 模式（设计「AppContext」）
  - [x] 2.2 实现 `switchSession(id)`：切换当前会话并持久化指针（需求 2.8、3.1）
  - [x] 2.3 实现 `pinSession(id)`：切换置顶标记并持久化（需求 2.7）
  - [x] 2.4 实现 `cloneSession(id)`：克隆并刷新列表，不改变当前会话（需求 4.1、4.3、4.5）
  - [x] 2.5 实现 `deleteSession(id)`：删除并在当前会话被删时新建（需求 5.1、5.2、5.3）
  - [x] 2.6 实现 `refreshSessions()` 与写入失败回滚后抛出（设计「错误处理」）
  - [ ]* 2.7 单元测试：写入失败回滚且向上抛出、删除当前会话后指针有效（设计「错误处理」）

- [ ] 3. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [ ] 4. 改造 ChatScreen 为会话维度
  - [ ] 4.1 消息读取改为 `getMessagesBySession(activeSessionId)`，并在会话切换时重置状态（需求 1.3、3.1）
  - [ ] 4.2 消息写入改为 `saveMessagesBySession` 并同步更新会话 `updatedAt` 与预览（需求 1.3、3.2、2.3）
  - [ ] 4.3 保留 `pending` 不落盘与 `activeCharacterIdRef` 守卫，新增会话维度过期判断（设计「ChatScreen」；需求 1.2）
  - [ ] 4.4 `onClear` 改为仅清空当前会话消息、保留会话并隐藏空会话（需求 6.1、6.2、6.3）
  - [ ]* 4.5 生命周期脚本：按会话读写、清空保留会话、切换丢弃迟到回复（设计「测试策略」）

- [ ] 5. 新增 MemoryScreen 记忆页
  - [ ] 5.1 渲染会话列表：角色头像、角色名、摘要、更新时间（需求 2.2、2.3）
  - [ ] 5.2 按置顶优先、更新时间倒序排列（需求 2.4、2.5）
  - [ ] 5.3 点击行调用 `switchSession` 并切换到聊天 Tab，同时把当前角色切为该会话所属角色（需求 2.8、3.1）
  - [ ] 5.4 每行提供置顶、克隆、删除按钮并接入对应操作（需求 2.6、2.7、4.1、5.1）
  - [ ] 5.5 删除与克隆二次确认，失败时 `Alert` 并保持列表（设计「错误处理」）
  - [ ] 5.6 空状态展示（需求 2.2）
  - [ ]* 5.7 渲染脚本：排序、置顶切换、副本标识、按钮回调、空状态（设计「测试策略」）

- [ ] 6. App.js 导航与冷启动接线
  - [ ] 6.1 `TAB_ICONS` 与 `Tab.Screen` 增加「记忆」入口（需求 2.1）
  - [ ] 6.2 冷启动调用 `migrateLegacyMessages` 与 `startNewSession`（需求 7.1、7.2、8.1；设计「App.js」）

- [ ] 7. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [ ] 8. 回归验证
  - [ ] 8.1 运行 `npm ci` 验证依赖与锁文件一致（设计「测试策略」）
  - [ ] 8.2 运行 `npx expo export --platform android` 验证打包成功（设计「测试策略」）
  - [ ] 8.3 同步 `.monkeycode/docs/` 中会话模型相关章节（需求 1、2、8）