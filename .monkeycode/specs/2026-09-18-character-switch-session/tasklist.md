# 需求实施计划

- [x] 1. 角色页切换同步会话
  - [x] 1.1 `CharacterScreen` 解构新增 `ensureCharacterSession`（设计「组件与接口」）
  - [x] 1.2 `onSwitch` 改为 `switchCharacter(id).then(() => ensureCharacterSession(id))`（需求 1.1、1.2、1.3）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 记忆页一致性
  - [x] 3.1 `switchSession` 已有会话指针切换；角色页切换后记忆页与聊天页一致（需求 3.1、3.2）

- [x] 4. 回归
  - [x] 4.1 脚本验证：`ensureCharacterSession` 三种输入下的活动指针
  - [x] 4.2 打包验证 `npx expo export --platform android`
  - [x] 4.3 文档同步