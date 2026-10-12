import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

import noHardcodedChinese, { noHardcodedChineseText } from './eslint-rules/no-hardcoded-chinese.mjs';

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['node_modules/**', 'android/**', 'ios/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        React: 'readonly', global: 'readonly', Promise: 'readonly', require: 'readonly',
        module: 'readonly', exports: 'readonly', process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly',
        queueMicrotask: 'readonly', fetch: 'readonly', FormData: 'readonly',
        XMLHttpRequest: 'readonly', AbortController: 'readonly', Buffer: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly',
        __DEV__: 'readonly', __dirname: 'readonly', URLSearchParams: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      'no-undef': 'error',
      // 仅 JSX 使用的标识符也要算作已使用。ESLint 10 core 自带该追踪，但 ESLint 9 core 没有；
      // 显式开启后，lint 在 9/10 下行为一致，不再隐式依赖 ESLint 10 的新行为。
      'react/jsx-uses-vars': 'error',
      // 真实规则违规会让 hooks 调用顺序错乱，按错误处理。
      'react-hooks/rules-of-hooks': 'error',
      // 未使用的变量/导入/参数：抓死代码。catch 参数与 React 默认导入按惯例忽略。
      'no-unused-vars': ['error', {
        args: 'after-used',
        ignoreRestSiblings: true,
        caughtErrors: 'none',
        varsIgnorePattern: '^React$',
      }],
    },
  },
  {
    // i18n 防复发（第一批）：用户可见文案（Alert.alert / throw new Error）不得硬编码中文。
    // 判定用本地规则 eslint-rules/no-hardcoded-chinese.mjs（AST 级，注释不算）。
    // 本批仍有的覆盖边界：只统计 Alert.alert / throw new Error 的**直接**中文字符串参数——
    // setNotice 类提示、Alert 按钮配置对象内的文案（如 { text: '取消' }）不在规则内
    //（ProactivePanel 全文件未接 i18n 却不在清单里，即此盲区；详见审查待办）。
    // JSX 正文与模块级导出常量已由下面的**第二批**规则（no-hardcoded-chinese-text）覆盖。
    //
    // 下面的 `ignores` 是**存量迁移清单（只减不增）**：由规则实测生成——81 个文件、
    // 763 处（2026-10-02 复测；早期注释里的「32 文件 / 559 处」是 grep 口径的误记，
    // 已废弃）。迁移方式 = 把文案换成 t('<key>') 并补 src/i18n/locales 双语言词条，
    // 然后从这里删掉该行；清单只允许变短。新文件一律不得加入。
    // 按文件的实测计数与分批计划见 .monkeycode/docs/审查待办.md。
    files: ['src/**/*.js', 'App.js'],
    ignores: [
      'src/i18n/**',
      // ---- 存量迁移清单（只减不增）----
      'src/CardForgeEditor.js',
      'src/ChatScreen.js',
      'src/localModel/modelCatalog.js',
      'src/storage/location.js',
    ],
    plugins: { local: { rules: { 'no-hardcoded-chinese': noHardcodedChinese } } },
    rules: {
      'local/no-hardcoded-chinese': 'error',
    },
  },
  {
    // i18n 防复发（第二批）：JSX 正文与**模块级导出常量**里的中文。
    // 首版只查 Alert.alert / throw new Error 的直接字面量参数，于是
    // `export const THINKING_PLACEHOLDER = '正在思考...'` 这类模块级常量（渲染层直接
    // 读走、永不随语言切换）与 <Text>你好</Text> 这类 JSX 正文全在规则之外。
    // 判定见 eslint-rules/no-hardcoded-chinese.mjs 的 noHardcodedChineseText。
    //
    // 第三批扩宽（2026-10-12）：同一条规则再加三种形态——
    //   · 数组 join() 的中文分隔符：`list.join('、')`（英文界面下预览/导出混入中文标点）；
    //   · 函数返回的对象字面量：`return { label: '内存未知' }`（调用方把 label 拼进英文句子）；
    //   · 模块级**非导出**常量：`const FIELD_LABELS = { name: '角色名' }`——不导出也一样
    //     能被同仓模块 import 走、照样渲染到界面上（SettingsScreen 的模型能力说明、
    //     moments 的预设文案等 9 文件 / 40 处就是这一类）。
    //     ⚠️ **函数体内的普通字符串常量仍然不覆盖**（imageDescriptionPrompt.js 记录过
    //     这条口径：函数体里的中文绝大多数是模型提示词）。
    // 并把**中文标点**纳入匹配：`join('、')` 里一个汉字都没有，只查汉字会整类漏掉。
    //
    // ⚠️ 本次清单**新增 68 行、删除 1 行（净 +67）**，全部来自规则扩宽，不是新债：
    // 扩宽前这些中文对规则不可见（既不报错、也不在旧清单里），扩宽后变成「看得见的存量」，
    // 不登记门禁立刻红。这不违反本清单「只减不增」的纪律——新增的全是**既有文件**，
    // 没有一个是新文件；纪律本身没变：删行才是迁移，加行只允许出现在「规则扩宽把不可见
    // 变可见」这一种场景，且必须像本节这样注明原因（否则下一个人会以为是违规加行）。
    // 例外只有两行，见下面 (b) 段末尾的 `logging/logger.js` / `storage/diagnostics.js`。
    //
    // 只剩一类形态**实测后放弃**，不写进规则：**模板串里的中文**（384 处 / 94 文件，
    // 约六成是模型提示词 / agent 内部工具文案，散在 9 棵树 ≈50 个文件；窄化成「单行且
    // ≤40 字」仍有 257 处 / 84 文件）。它与提示词在 AST 上同形，没有简单判据可分离。
    // 已知盲区与两处仍然看不见的用户可见中文（advanced.js:139/166、modelParams.js:90）
    // 详见 eslint-rules/no-hardcoded-chinese.mjs 头注释的「已知盲区」一节。
    //
    // 下面是与首批**互相独立**的存量冻结清单（只减不增）：由扩展后的规则实测生成。
    // 迁移方式 = 换成 t('<key>') / 改导出 i18n key 并补 src/i18n/locales 双语言词条，
    // 然后从这里删掉该行。新文件一律不得加入。
    //
    // ⚠️ 清单里有两类，删行前先看清：
    //   (a) 待迁移：用户可见文案（如 onboarding/**、settings/presets.js）；
    //   (b) 永久豁免：**不该进 i18n 的中文**——workspace/toolDefs/** 的工具描述是
    //       发给模型的提示词（仓库铁律：模型提示词不进 i18n）、settings/searchIndex.js
    //       是匹配用关键词、navigation/routeNames.js 是路由名。这类文件留在这里表示
    //       「已知且不迁」，迁移方向是把中文从常量里挪走（改为 key/表驱动），而不是塞进 locale。
    files: ['src/**/*.js', 'App.js'],
    ignores: [
      'src/i18n/**',
      // ---- (b) 永久豁免：内容**不该进 i18n**（模型提示词 / 匹配关键词 / 内部标识符）----
      // 这些文件里的中文是发给模型的提示词、参与匹配的关键词，或用户自己输入的固定
      // 命令字（如 @全体、路由名）。迁移方向是「把中文从常量里挪到表驱动」，不是塞进 locale。
      // ⚠️ 2026-10-12 复核：曾有一版把 logging/logger.js 与 storage/diagnostics.js 以
      // 「结构性豁免」为理由放进本段，理由不成立——那两处是 '[脱敏不可用，已省略]' 这类
      // **用户会读到的占位文案**（诊断页可在应用内查看与复制，见 DiagnosticsModal.js），
      // 属 (a) 待迁移。零依赖纯模块的**结构**问题该靠「词条 key 常量」解决
      // （导出 key、由使用处 t(key) 取值），不该靠豁免文案。已移回 (a) 段。
      'src/aigc/attribution.js',
      'src/agent/loop.js',
      'src/agent/planNudge.js',
      'src/agent/subagent.js',
      'src/cardForge/forge/assist.js',
      'src/character/cardParser/regexScripts.js',
      'src/character/cardParser/worldInfo.js',
      'src/chat/compaction.js',
      'src/chat/groupMentions.js',
      'src/memory/memoryConstants.js',
      'src/navigation/routeNames.js',
      'src/plugins/registry.js',
      'src/prompt/chatPipeline.js',
      'src/settings/searchIndex.js',
      'src/workspace/assistant.js',
      'src/workspace/chat.js',
      'src/workspace/commands.js',
      'src/workspace/hooks.js',
      'src/workspace/memory.js',
      'src/workspace/skills.js',
      'src/workspace/teams.js',
      'src/workspace/templates.js',
      // 工具描述整族都是模型提示词（tools 的 description 字段）：整目录豁免，
      // 新增工具文件也自动在内——这正是我们要的，工具描述不该翻成英文界面语言。
      'src/workspace/toolDefs/**',
      // 第三批扩宽新增（(b) 段）：join() 分隔符 / 返回对象字面量的命中，中文的去向
      // 都是「发给模型的提示词或工具协议回传文案」，按 (b) 的定义永久豁免。
      'src/agent/blackboard.js',
      'src/agent/rpc.js',
      'src/agent/task/taskModel.js',
      'src/agent/task/taskPrompt.js',
      'src/agent/tools/registry.js',
      'src/agent/workflow.js',
      'src/chat/chatTools.js',
      'src/chat/compactionPipeline.js',
      'src/chat/groupChat/context.js',
      'src/chat/groupChat/ensemble.js',
      'src/chat/groupChat/opening.js',
      'src/chat/groupChat/scheduler.js',
      // schedule.js 里写明了「供提示词使用的作息摘要（中文，不进 i18n）」。
      'src/chat/schedule.js',
      'src/chat/sessionCompaction.js',
      'src/cardForge/forge/prompts.js',
      'src/moments/runHousemateReactions.js',
      'src/moments/runUserMomentComments.js',
      // mcpTools.js 是 MCP 工具的 description 与协议回传文案（同 toolDefs/** 一族）。
      'src/workspace/mcpTools.js',
      'src/workspace/readLog.js',
      // ChatPanel.js 命中的是追加进工具结果正文的「[工作区钩子] …」（模型读的那份）。
      'src/workspace/screen/ChatPanel.js',
      'src/workspace/shell.js',
      'src/workspace/store.js',
      // 第三批扩宽（第二轮）新增 (b)：模块级**非导出**常量的命中，中文的去向仍是
      // 「提示词 / 匹配关键词 / 正则」。
      'src/agent/task/taskRunner.js',            // 定时任务提示词（「（定时任务，请现在执行）」）
      'src/books/blocks.js',                     // 章节标记正则/关键词（[章节回卷部篇幕集]、数字汉字类）
      'src/books/fullTextDecoder.js',            // 解析用关键词（'你'）
      'src/memory/conflict.js',                  // 记忆冲突判定提示词
      'src/moments/affinity.js',                 // 好感度**情感词表**（喜欢/讨厌/…，匹配用）
      'src/network/requestErrors.js',            // 接口错误**匹配关键词**（不支持/未知参数/…）
      'src/proactive/proactiveRequest.js',       // 格式指令**匹配词表**（必须输出/强制输出/…）
      'src/storage/settings/imageRecognition.js',// 图片识别提示词
      // ⚠️ 下面两条是**并发批次新增的代码**（`[脱敏不可用，已省略]`），不是既有存量：
      // 那两个文件的注释当时明写「不导出是刻意的……eslint 只查模块级**导出**常量，
      // 非导出常量不在其内」——即**主动利用了本次要补的盲区**。本次扩宽把它暴露出来。
      // 归 (b) 的理由是**结构性**的（零依赖纯模块 + 只出现在诊断日志），不是提示词/关键词。
      // ⚠️ 待办：那两处注释现在**已过时**（非导出常量已纳入规则），应由该批 owner 更正；
      // ↓ 2026-10-12 复核：判定该文案**属用户可见**（诊断页可在应用内查看/复制，见
      //   DiagnosticsModal.js），故**改判 (a)**、走 i18n。零依赖的**结构**问题该靠
      //   「导出词条 key、由使用处 t(key) 取值」解决（同 chat/toolTrace.js 的
      //   TRACE_TRUNCATE_MARK_KEY 做法），不该靠豁免文案。
      // ---- (a) 待迁移：用户可见文案（换 t('<key>') 后从这里删行）----
      // ⚠️ 下面两条**不能删**：2026-10-12 有人以 `--no-ignore` 通过为由建议删掉它们，
      //   但那一次验证跑在**第三批规则（模块级非导出常量）扩宽之前**，所以漏判了——
      //   这两个文件里除已迁移的 Error 文案外，**模块级常量**仍硬编码中文
      //   （memorySummary.js 的提示词表、api.js 的错误文案表）。删掉即刻 19 处报错。
      //   教训：**删冻结清单行必须在规则集冻结之后复跑**，否则"验证通过"是假象。
      'src/logging/logger.js',
      'src/storage/diagnostics.js',
      'src/memory/memorySummary.js',
      'src/network/api.js',
      // ↓ 下面两条原先误归在 (b)：state.js 的 FORGE_QUESTIONS 是问答提示、
      //   shared.js 的 FIELD_LABELS 是表单字段标签，都是**用户可见文案**，与 (b) 的
      //   定义（模型提示词 / 匹配关键词 / 用户输入的固定命令字）不符。
      //   本次只把它们从 (b) 挪到 (a)（不动源码），迁移方向随之变为「换 t('<key>') +
      //   补 src/i18n/locales 双语言词条」，而不是「把中文挪出常量」。
      'src/cardForge/forge/shared.js',
      'src/cardForge/forge/state.js',
      'src/character/cardHelpers.js',
      'src/chat/reactiveCompact.js',
      'src/chat/voiceMessages.js',
      'src/games/games.js',
      'src/imageGen/providers.js',
      'src/localModel/modelState.js',
      'src/memory/memoryBuckets.js',
      'src/network/apiVendors.js',
      'src/onboarding/disclaimerContent.js',
      'src/onboarding/onboardingContent.js',
      'src/plugins/providers.js',
      'src/settings/presets.js',
      'src/storage/characters/shared.js',
      'src/tts/providers.js',
      'src/vectorMemory/providers.js',
      'src/workspace/plugins/market.js',
      // 第三批扩宽（第一轮）新增 (a)：join() 分隔符 / 返回对象字面量的命中，中文都会
      // 出现在用户看得见的地方（界面文案、导出文件、错误提示），按 (a) 的定义待迁移。
      'src/BackupPanel.js',
      'src/CardForgeEditor.js',
      'src/CardForgeScreen.js',
      'src/CardPreviewModal.js',
      'src/cardForge/forge/advanced.js',
      'src/cardForge/forge/draft.js',
      'src/character/CharacterDetailScreen.js',
      'src/character/CharacterLibraryScreen.js',
      'src/character/editors.js',
      'src/chat/ConversationCardModal.js',
      'src/chat/conversationExport.js',
      'src/chat/useChatSend.js',
      'src/ChatScreen.js',
      'src/extension/schedule/preview.js',
      'src/imageGen/localDream.js',
      'src/localModel/modelCompatibility.js',
      'src/MapPanel.js',
      'src/MemoryScreen.js',
      'src/ProactivePanel.js',
      'src/storage/dataBackup.js',
      'src/storage/secrets.js',
      'src/TranscriptionPanel.js',
      'src/workspace/packs.js',
      'src/workspace/plugins/loader.js',
      'src/workspace/plugins/manifest.js',
      'src/workspace/plugins/registry.js',
      'src/WorkspaceCapabilitiesCard.js',
      // 第三批扩宽（第二轮）新增 (a)：模块级**非导出**常量的命中，中文都会出现在
      // 用户看得见的地方（设置页说明、预设文案、日期/地图标签、导出文件、错误提示）。
      'src/chat/currentTime.js',                 // 星期几标签（日/一/二/…）
      'src/chat/toolTrace.js',                   // 工具轨迹截断提示「…（轨迹截断）…」
      'src/moments/moments.js',                  // 预设动态文案（用户可直接选用/展示）
      'src/SettingsScreen.js',                   // 模型能力说明（reasoning_effort 档位等）
      'src/storage/settings/plugins.js',         // 插件说明与默认描述
      'src/worldMap/map.js',                     // 地图默认房间名「无主房」
      'src/worldMap/realMapHtml.js',             // 内嵌地图 HTML 的可见标签（放大/缩小/回到我的位置）
      'src/worldMap/RealMapView.js',             // 「位置设置读取失败」提示
      // ⚠️ 本段原先的 'src/workspace/gitCheckpoint.js' 已**删除**（正当的「只减」）：
      // 另一个批次把该文件的中文导出常量改成了 CHECKPOINT_FALLBACK_KEY（导出 key
      // 而不是中文），实测该文件对本规则已无命中。
    ],
    // 插件命名空间用 local-i18n：ESLint flat config 不允许在两个配置对象里重复定义
    // 同一个插件名（"Cannot redefine plugin"），而本批必须与首批用**不同的 ignores**。
    plugins: { 'local-i18n': { rules: { 'no-hardcoded-chinese-text': noHardcodedChineseText } } },
    rules: {
      'local-i18n/no-hardcoded-chinese-text': 'error',
    },
  },
  {
    // 分层约束：持久化原语只允许在存储层内直接引用，UI/业务文件一律走
    // `src/storage.js` 门面或域模块。破坏这条约定最容易表现为「绕过损坏备份 /
    // 绕过密钥脱敏 / 绕过 SQLite 大值兜底」，且很难靠 review 拦住。
    //
    // 豁免（既有分散引用，属历史债，新增文件不得再加入）：
    //   - `src/storage/**`、`src/storage.js`：存储实现本身；`secretStore.js`
    //     （expo-secure-store 唯一封装点）、`diagnostics.js`（惰性 require
    //     AsyncStorage）与 `secrets.js` 已归入 `src/storage/`；
    //   - `src/books|music|screenWatch/**`：这三个后加域自持存储键，尚未并入
    //     storage 层（见 `.monkeycode/docs/审查待办.md`）。
    files: ['src/**/*.js'],
    ignores: [
      'src/storage/**',
      'src/storage.js',
      'src/books/**',
      'src/music/**',
      'src/screenWatch/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@react-native-async-storage/async-storage',
            message: '持久化统一走 src/storage/ 域模块或 src/storage.js 门面，不要在 UI/业务文件里直接读写存储。',
          },
          {
            name: 'expo-sqlite',
            message: 'SQLite 仅用于 src/storage/io.js 的大值读取兜底。',
          },
          {
            name: 'expo-secure-store',
            message: '安全存储只允许在 src/storage/secretStore.js 内使用。',
          },
        ],
      }],
    },
  },
  {
    // 文件系统分层：`expo-file-system` 的写入若忘记 markMediaWrite（写文件后登记保护
    // 窗口），用户图片会被孤儿回收器误删——而 lint 不会告诉你漏了哪处。
    // 本规则先把「新债」冻住：下面 ignores 是实测的存量清单（28 个文件，只减不增）。
    // 迁移方向：文件操作逐步收进域内封装点（封装点内部强制 markMediaWrite），
    // 每迁完一个文件从清单删一行。新文件一律不得加入。
    files: ['src/**/*.js'],
    ignores: [
      'src/storage/**',
      'src/storage.js',
      'src/i18n/**',
      // ---- 存量清单（只减不增）：实测 28 个直接引用 expo-file-system 的非存储文件 ----
      'src/BackupPanel.js',
      'src/CharacterEditForm.js',
      // 同上：详情页承接了 CharacterScreen 原有的 expo-file-system/legacy 直用（图片三重守卫、
      // 导入落盘），属既有存量债随文件迁移，不是新增引用。
      'src/character/CharacterDetailScreen.js',
      'src/GroupEditForm.js',
      'src/ImageGenScreen.js',
      'src/books/BookScreen.js',
      'src/books/importBook.js',
      'src/books/library.js',
      'src/cardForge/media.js',
      'src/character/cardExporter.js',
      'src/character/defaultCharacterAssets.js',
      'src/chat/RichHtmlMessage.js',
      'src/chat/attachments.js',
      'src/chat/audioModules.js',
      'src/chat/stickerImages.js',
      'src/chat/useChatSend.js',
      'src/chat/useChatTts.js',
      'src/localModel/modelManager.js',
      'src/music/MusicScreen.js',
      'src/music/importMusic.js',
      'src/proactive/proactiveRequest.js',
      'src/screenWatch/capture.js',
      'src/settings/useUserProfile.js',
      'src/workspace/location.js',
      'src/workspace/native.js',
      'src/workspace/picker.js',
      'src/workspace/safStore.js',
      'src/workspace/store.js',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'expo-file-system',
            message: '文件系统操作请走域内封装点（内部统一 markMediaWrite 保护媒体文件）；新文件不要直接 import expo-file-system。',
          },
          {
            name: 'expo-file-system/legacy',
            message: '文件系统操作请走域内封装点（内部统一 markMediaWrite 保护媒体文件）；新文件不要直接 import expo-file-system/legacy。',
          },
        ],
      }],
    },
  },
];
