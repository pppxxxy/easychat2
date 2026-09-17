# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-09-17
- Context: 执行对话预设与聊天链路的逐项代码质量检查
- Category: Testing Methods
- Instructions:
  - 无测试框架时用 Node 脚本做回归验证：Babel 转换 src/*.js（storage.js 等用 commonjs + async 插件；含 JSX 的 SettingsScreen/CharacterScreen 需额外加 @babel/plugin-syntax-jsx），配合 AsyncStorage mock 在 vm 中执行
  - 并发/竞态验证用 fixture 模式：失败注入（failures.get/set）与写入挂起（hold/release）模拟落盘窗口
  - 上述脚本是会话临时产物，生成在 /tmp/opencode，不入库；需要时按上述方式重建
