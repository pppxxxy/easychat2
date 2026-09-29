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

[User Instruction Summary]
- Date: 2026-09-24
- Context: 接收 easychat2 代码审核建议并继续修复
- Instructions:
  - 独立核验每条审核建议，确认问题真实存在后再实施。
  - 采纳综合判断后必要的修复，保持一个主题一个提交并完成对应回归测试。

[User Instruction Summary]
- Date: 2026-09-25
- Context: 继续进行 EasyChat2 全仓库逐行审查与修复
- Instructions:
  - 在用户明确授权前禁止执行 git commit 与 git push。
  - 按逻辑问题、未命名变量或其他调用错误、修复回归、大角色卡运行与渲染、其他 Bug 五类逐文件逐行检查。
  - 检查结果必须有代码证据或可重复验证，确认后补充到 `.monkeycode/docs/审查待办.md`。
  - 按依赖关系逐项修复，每次修复补充对应回归测试，完成全部门禁后汇报并等待用户检查。

[User Instruction Summary]
- Date: 2026-09-29
- Context: 平台搜索积分将耗尽，需增设备用联网搜索能力
- Instructions:
  - 备用联网搜索使用 AnySearch，配置在 opencode 全局配置 `~/.config/opencode/opencode.json` 的 `mcp.anysearch`（remote / Streamable HTTP，`https://api.anysearch.com/mcp`），真实 Key 只存该全局配置，不写入项目仓库或文档。
  - AnySearch 也可直接用 REST：`POST https://api.anysearch.com/v1/search`，`Authorization: Bearer <key>`，Body `{ query, max_results, zone, language, domain? }`；另有 `/v1/extract`、`/v1/sub-domains`；无 Key 时匿名有免费额度。
  - **搜索优先用 AnySearch**：平台自带搜索消耗积分，AnySearch 免费；需要联网查资料时默认走它，省积分。
  - 能力边界（2026-09-29 实测）：`/v1/search` 中英文/垂类（domain，如 `code`/`finance`）均可用，但 snippet/content 很短（约 160 字），要完整正文需再调 `/v1/extract`。
  - `/v1/extract` 只能抓静态页与原始文件（GitHub raw / 静态博客有效，实测 llama.rn README 抓到 32KB 全文）；对 JS 渲染的 SPA 文档站会返回 `code:-1 / extract_failed: Unable to extract content from the URL`（如 `docs.expo.dev`）。
  - 遇到抓不动的 SPA 文档站：退回用 search snippet 佐证，或换 GitHub / raw / 镜像源，不要反复重试 extract。
  - 新增或修改 opencode 配置后需重启 opencode 才生效（配置不热重载）。
