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

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: main（23ff019）Release 打包 `:app:compileReleaseKotlin` 失败：ScreenOverlayModule.kt 报 `Unresolved reference 'currentActivity'`
- Category: Troubleshooting & Debugging
- Instructions:
  - RN 0.81 把 `ReactContextBaseJavaModule.getCurrentActivity()` 从 Java 方法改成了**带 `@Deprecated` 的 Kotlin 函数**。Kotlin 只会为 Java getter 合成属性，因此原生模块子类里裸写 `currentActivity` 不再解析（编译报 Unresolved reference）；旧版本能编译是因为那时是 Java getter。
  - 正确写法是走 `ReactApplicationContext` 的 Java getter：`reactContext.currentActivity`（或官方向导说的 `reactApplicationContext.currentActivity`），不要用 `currentActivity`，也尽量别调用已过时的 `getCurrentActivity()`。
  - 同类坑排查面：所有 `plugins/*/android/*.kt` 里凡引用宿主 Activity 的地方都要按此改；`android/` 是 prebuild 生成、gitignored，改的是 `plugins/` 下的源文件。
  - 本地无 Android SDK/Java/Gradle 时无法编译 Kotlin 验证；此类原生编译修复只能靠 CI（workflow_dispatch 的 Gradle workflow）或真机 prebuild 构建确认。

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: main（6ab5143）Release 打包再报 Kotlin 编译错误：ProactiveCore.kt 两处类型不匹配 + OverlayService.kt 一处构造器候选无一适用
- Category: Troubleshooting & Debugging
- Instructions:
  - **Kotlin `?:`（elvis）优先级低于链式调用**：`a() ?: b().let{...}.toRequestBody()` 中的 `.let/.toRequestBody` 只作用于 `b()`，导致左侧 `String?` 与右侧 `RequestBody` 合流为 `Any`，后续按 `String` 用就报 `actual type is 'Any'`。快照/回退这类「两分支合流再加工」的写法必须先把 elvis 结果落到一个变量，再对变量做链式加工。
  - **OkHttp 的 `Request.Builder.post()` 只接受 `RequestBody`**：别把 `String` 直接 post；`"...".toRequestBody(mediaType)` 后传，并 `import okhttp3.RequestBody`（`toRequestBody` 的 import 不等于类型 import）。
  - **Kotlin 没有 `String(String)` 构造器**：`String(x)` 只接受 ByteArray/CharArray/StringBuffer/StringBuilder；x 已是 String 时应直接 `x.trim()`，否则报「None of the following candidates is applicable」。
  - **Z 链并入 main 后原生未编译即合入**：这两处错误都是 Z 线新加的原生代码，JS 门禁（lint/test/export）全绿却编译不过。凡是改动 `plugins/*/android/*.kt` 的提交，CI 的 Gradle workflow 是唯一可信验证；合并前应至少跑一次 APK 构建。
  - 教训：main 自 Z 三链并入起未成功构建过，Native 错误是逐个暴露的；这类修复要一次把同一批新增 Kotlin 全审一遍，别只修 CI 报的第一处。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: z1005z2 批次（工作区思考强度/上下文占用/compact 压缩指令）实现与测试
- Category: Testing Methods
- Instructions:
  - `tests/i18n.test.mjs` 把「记忆总结」等列为**提示词片段**并反向断言词条表不得包含——给聊天/记忆相关 UI 写中英文案时要绕开这些片段（如改说「总结开关」），否则 i18n 测试红。
  - `getMessagesBySession(id)` 直接返回消息数组，**不是** `{ messages }` 包装（MomentsView/MemoryScreen 均按数组用）；跨层传消息前先核形状。
  - 记忆总结两路径语义：手动（`runSummarize(manual=true)`，含聊天 compact 指令）绕过「记忆总结」总开关与条数阈值；自动路径受总开关约束，80% 上下文占用（`chat/contextUsage.js` 的 AUTO_COMPACT_RATIO）只是绕过**条数阈值**、不绕过总开关。
  - 经 bash heredoc→Python 写多行源码断言时 `\n` 转义会塌成真实换行，字符串字面量跨行直接 SyntaxError；源码断言优先拆成**相邻两条单行断言**或用正则 `\s*` 连接。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 生产包 BookScreen「打开书必崩」查证（Element type invalid: got undefined）
- Category: Troubleshooting & Debugging
- Instructions:
  - **Metro 对不存在的具名导入不报错**：`import { X } from './y.js'` 而 y.js 只有 default 导出时，X 绑定为 undefined——lint、Node 单测、`expo export` 全部静默通过，直到运行时按用途炸开（组件=Element type invalid；函数=TypeError not a function）。生产链排查这类崩溃时先查具名/默认导入错配。
  - 守卫已固化：`tests/namedImportSanity.test.mjs`（@babel/parser AST 全仓库扫描，处理 as 别名/export * 转发/解构导出）；新增具名导出或改名时若漏改导入方，npm test 会红。
  - 描述崩溃时组件名要对着代码核（本次报告里的「BookItem 列表项」并不存在，实为 BookReaderView 导入错配），格式相关的第一直觉（txt/docx 差异）也要先用最小复现排除。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: z1005z2 批次：GitHub MCP 连接（风险分级）+ 工作区环境配置下载
- Category: Workflow & Collaboration
- Instructions:
  - **安全约束（长期有效，用户裁决）**：GitHub MCP 工具白名单分级（只读直放/写入逐条确认/其余拒绝），删除分支、删除文件、强推、管理类**无条件禁止**——即使用户同意也不可解锁；改 riskGate.js 前先读 SMOKE §9.12 与 SECURITY §7.5。
  - Metro 对不存在的具名导出不报错（运行时 undefined），除 namedImportSanity 守卫外，新增跨模块导出时顺手跑一遍 npm test 即可拦截。
  - 工作区写入白名单 paths.js 扩展约定：**精确文件名清单（CONFIG_FILE_NAMES）只增不改**，不做任意点文件通配。
  - 本环境超长 bash heredoc 会被截断、`\` 会折半：大改动一律用 Edit 工具；向 JS 写入 `
` 字面量时用 `chr(92)+'n'` 构造。
  - 注入验证两个新抓的盲区：子串断言会被注释掉的调用骗过（用行首锚定正则）；「默认拒绝」类守卫的行为断言测不到模式本身（补源码断言钉住模式与白名单交集）。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: z1005z3：向量记忆「关键词模式」串记忆通道修复（审核报告全单核实属实）
- Category: Troubleshooting & Debugging
- Instructions:
  - **「开关」语义审计法**：看到一个布尔开关，必须追它的每一条消费分支——开关关掉后是「什么都不做」还是「降级到另一条路径」。向量记忆的 enabled 就是反例：关闭=关键词检索（更松），用户以为关=关。这类 fail-open 降级是隐私/记忆类功能的头号泄漏源。
  - **fail-closed 原则**：缓存/会话绑定的钥匙（conversationKey）缺失时必须默认清空重置，不能默认沿用——「没钥匙」要当作「换对话」而不是「同对话」。写守卫时先想清楚默认方向。
  - **兜底桶污染链**：任何 `id || 'default'` 式兜底 + 按角色共享的存储 + 单字匹配召回，三者叠加会让兜底卡变成跨会话记忆垃圾场；新增归属型存储时拒绝 default 兜底，对账时校验归属。
  - 注入验证的子串盲区已三次出现：断言 `includes('name')` 会被改名后的其他出现点（JSX 使用处/注释/另一个调用点）骗过——一律用「定义+使用」双锚点或行首锚定正则。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: z1005z3：工作区优化指令书落地（布局重排/套餐/GitHub 仓库快照导入）
- Category: Build Methods
- Instructions:
  - GitHub 仓库拉取在 RN 上的正解是 codeload zip + fflate 解压（books 模块已有依赖与防御模式可照抄：只读目录元数据扫描 → 按需解压 → 实际长度复核）；run_shell 是 /system/bin/sh，没有 git 二进制，git clone 死路。
  - fflate 测试可用 zipSync 直接构造恶意 zip（键名带 ../.. 的越界条目），配合「缩小限额注入 limits 参数」测限额路径，不必真造 50MB 数据。
  - 指令书/审核报告也会报错文件名（如本次 WorkspaceSettingsSheet.js 不存在）——落地前先 ls 核实，别照单全收。
  - 沙盒导入类功能的单文件上限应对齐下游读取能力（store 的 MAX_READ_CHARS=1MB），而不是拍脑袋的磁盘口径；超限跳过并计数比中止整批更合理。

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: z1005z3：大文件分段读取（offset/limit）与编辑截断守卫
- Category: Troubleshooting & Debugging
- Instructions:
  - **读截断 + 写回 = 数据损坏**：凡是「读（带截断）→ 加工 → 写回原路径」的链路，必须检查截断标志。本次两条后端（store.js/safStore.js）的 edit 都漏了这个守卫，>1MB 文件一编辑就砍尾。
  - **后端包装器是参数丢失的高发区**：给底层函数加新参数时，必须同时检查所有手动封装的 wrapper（createLegacyWorkspaceStore 这类）有没有透传——函数签名不报错，参数静默丢失。测试要在「经工具层调用」这一层断言行为，不能只测底层函数。
  - 分段读取的返回形状：content/truncated/offset/total/nextOffset——模型靠 nextOffset 续读，提示文案里必须明写「继续读取请用 offset=…」，否则模型不会自己发现。

[User Instruction Summary]
- Date: 2026-10-05
- Context: 聊天页顶栏底栏排版优化指令书落地时的裁决
- Instructions:
  - **免责声明常驻是硬性合规要求**（「AI 生成可能有误，仅供参考」顶栏常驻，防法律风险）。
    任何「一次性消失」「可关闭」的优化建议一律否决，不考虑；tests/chatTopBottom.test.mjs 已钉死防回归。
