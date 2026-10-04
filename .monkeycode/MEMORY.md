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

[Project Knowledge Summary]
- Date: 2026-09-30
- Context: 用户要求在上下文压缩后仍能恢复项目进度
- Category: Workflow & Collaboration
- Instructions:
  - **恢复进度先读 `.monkeycode/docs/进度交接.md`**：记录当前分支结构（main / 0a `chore/sdk54-upgrade` / 0b `chore/sdk54-newarch-probe`）、下一步动作、未完成待办、门禁基线与易踩的坑。
  - 三处同名提交靠 cherry-pick 同步（不要 merge）；0a/0b 相对 main 差异仅 SDK 54 必需项；main 每批改完 cherry-pick 到两分支并各自 push。
  - 升级路线已定：SDK 50→54 / RN 0.73→0.81 / 新架构开，均已在 0a/0b 分支完成，只差 0b 真机验证 `[INTEROP_PROBE]` 探针；探针过则零改造，不过才迁 TurboModule（0c，范围仅 `plugins/proactiveMessage/android/*.kt` 约 1168 行）。勿再重新调研版本链。
  - 该文件是「时间点状态」，会随进展更新；架构与约定的权威来源仍是 `AGENTS.md` 与 `.monkeycode/docs/`。

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

[Project Knowledge Summary]
- Date: 2026-10-03
- Context: 并合 Z-workspace-folder / Z-media-cards 时连环踩到的 git 坑（Zcode 合并报告复盘的四个高危点）
- Category: Troubleshooting & Debugging
- Instructions:
  - **`.gitignore` 目录级规则的陷阱**：`android/` 这类规则连目录本身一起排除，git 不再往里面看；单独写 `!plugins/<name>/android/**` 无效，必须「免目录 + 免内容」两行成对（`!plugins/<name>/android/` + `!plugins/<name>/android/**`）。本仓库已有 proactiveMessage/localApiServer/shellExecutor 三组样例；守卫测试 `tests/pluginKotlinTracked.test.mjs` 会拦「目录存在但 .kt 未被跟踪」。
  - **本地绿灯 ≠ 可合**：工作区里有但未 `git add` 的源码会让本地测试全绿，干净检出里红（典型：`ENOENT: scandir 插件/...`）。复审流程必须**干净分离检出**（`git worktree add --detach <tip>`）再跑门禁，不能只看当前工作区。
  - **复审他人分支前必双查 tip**：先 `git fetch`，再用 `git ls-remote` + `%ci`（committer date）确认 tip 是最新；本仓库已发生三次陈旧 tip 误判（两次扯出误判）。
  - **门禁要跑在合并树上**：`git merge --no-commit` 预演后，在预演出的合并树上跑 lint / test / cov / export；不要只对单分支跑。两个分支各自绿不等于合并树绿（本仓库出现过 §9.9 撞号）。
  - **同编号章节"撞号不撞行"**：并行分支各自往同一文档加新节（如 SMOKE_TEST.md 的 §9.9）不会触发 git 冲突，但合并后会出现两个同号 section。合并后要检查章节号唯一性——媒体那节已改 §9.10。

[User Instruction Summary]
- Date: 2026-10-03
- Context: monkey 推 `m-merge-media-cards-workspace-folder` 与 Zcode 并行合并 main 时的跨代理分工
- Instructions:
  - 跨代理分支（m-* 为 monkeycode，Z-* 为 Zcode）的合并由用户决定，不只作主张推进别人的分支。
  - 如果另一个代理分支里有价值的只是某个文档提交（如本仓库的 `f1d5c89` 只改 README / 审查待办 / MEMORY / 依赖注释），**摘那个文档提交而不是整枝合并**——整枝合并会把对方已修的撞号退回，并在已惊过的冲突文件上再冲一次。
  - 合并冲突的默认解法是「两节都留、各自标记归属」；节号冲突时再手工改号并同步其他文件里的引用（不要只改正文，引用处同样会指向旧号）。

[Project Knowledge Summary]
- Date: 2026-10-03
- Context: `src/` 归组 codemod（Chapter*→books/、proactive*→proactive/）实践
- Category: Troubleshooting & Debugging
- Instructions:
  - 搬迁模块时，**相对路径的 codemod 必须同时覆盖动态 `import('./x.js')` 与 `require('./x.js')`**，不能只改静态 `import ... from`。静态 lint 与 Node 单测都可能放过未执行的动态分支，只有 `npx expo export`（Metro 解析全图）会暴露 `Unable to resolve module ./x.js`。
  - 每批归组后按顺序验证：`npm run lint` → `npm test` → `npx expo export --platform android`，三关都过再提交。前两关不足以保证 Metro 能打包。
  - 搬迁还需同步的非代码处：`.c8rc.json` 覆盖排除路径、`AGENTS.md`、`.monkeycode/docs/ARCHITECTURE.md`/`INTERFACES.md`/`模块/*.md`，以及 `scripts/guard-structure.mjs` 的根文件数阈值（迁移后下调）。

[Project Knowledge Summary]
- Date: 2026-10-03
- Context: `memory*` 迁入 `src/memory/` 时测试加载器被打断
- Category: Troubleshooting & Debugging
- Instructions:
  - 用 `Module._load` 打桩/拦截的测试（如 `tests/memorySummary.test.mjs`）若按**精确相对说明符**匹配（`request === './storage.js'`），模块搬迁改成 `../storage.js` 后拦截会失效，测试会去加载真实模块并失败。搬迁时这类加载器要改成**按 basename 匹配**（`String(request).split('/').pop() === 'storage.js'`）。
  - 同理，源码断言测试里写死的相对路径字符串（如 `SCREEN_SOURCE.includes("from './memoryBuckets.js'")`）也要随搬迁更新。
