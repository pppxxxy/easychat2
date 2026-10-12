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
    // 下面的 `ignores` 是**存量迁移清单（只减不增）**：2026-10-12（m1012m14）已**清零**——
    // 最后 12 处（memorySummary / CardForgeEditor / ChatScreen / modelCatalog / storage/location）
    // 全部迁完，规则现对全仓零豁免生效。清单只允许变短；新文件一律不得加入。
    // 迁移方式 = 把文案换成 t('<key>') / tActive('<key>') 并补 src/i18n/locales 双语言词条。
    files: ['src/**/*.js', 'App.js'],
    ignores: [
      'src/i18n/**',
      // 首批规则（Alert.alert / throw new Error）的存量清单已**清空**（2026-10-12，m1012m14）：
      // 剩余 12 处（memorySummary 6 / CardForgeEditor 2 / ChatScreen 2 / modelCatalog 1 /
      // storage/location 1）全部迁到 t()/tActive() 并补齐 zh-CN/en 词条，规则现在对全仓零豁免生效。
      // 此前这里挂着的 77 个文件其实早已迁完、只是清单一直没回收——清单只减不增，迁完即删行。
      // 新文件一律不得加入；`src/i18n/**` 是文案本身，永久豁免。
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
      'src/agent/loop.js',
      'src/agent/planNudge.js',
      'src/agent/subagent.js',
      'src/cardForge/forge/assist.js',
      'src/cardForge/forge/shared.js',
      'src/cardForge/forge/state.js',
      'src/character/cardParser/regexScripts.js',
      'src/character/cardParser/worldInfo.js',
      'src/chat/compaction.js',
      'src/chat/groupMentions.js',
      'src/memory/memoryConstants.js',
      'src/memory/memorySummary.js',
      'src/navigation/routeNames.js',
      'src/plugins/registry.js',
      'src/prompt/chatPipeline.js',
      // 2026-10-12（m1012m14）：以下原列在 (a) 待迁移，核实后确认是**内容/数据/提示词**，
      // 中文是其正确形态、翻译反而有害，故改判为永久豁免：
      'src/aigc/attribution.js',             // AIGC 合规标识随卡片数据导出（GB 45438），非界面文案
      'src/chat/voiceMessages.js',           // VOICE_PLACEHOLDER_TEXT 是发给模型的占位文本（模型输入）
      'src/memory/memoryBuckets.js',         // label 是 labelKey 的中文兜底（非 React 消费方/纯逻辑测试）
      'src/onboarding/onboardingContent.js', // 教程内容（AGENTS.md 明列例外）
      'src/storage/characters/shared.js',    // 内置助手的人设名与系统提示（角色卡内容）
      'src/workspace/gitCheckpoint.js',      // CHECKPOINT_FALLBACK_MESSAGE 写入 git 提交信息（持久数据）
      // 2026-10-12：settings/searchIndex.js 的**标签**已全部迁走（label → labelKey，
      // 复用卡片自己的 settings.<x>.* 键，分区名同理）。留在这里只剩 keywords——
      // 那些是「用户会输入什么」的匹配词，中英混排、不该翻译。
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
      // ---- (a) 待迁移：用户可见文案（换 t('<key>') 后从这里删行）----
      'src/games/games.js',
      'src/imageGen/providers.js',
      'src/localModel/modelCatalog.js',
      // 2026-10-12：src/localModel/modelState.js 已迁出（下载源 name → nameKey；note 无人渲染已删）。
      // 2026-10-12：src/network/api.js 已迁出（错误文案走 tActive；两处哨兵常量就地豁免）。
      'src/network/apiVendors.js',
      'src/onboarding/disclaimerContent.js',
      'src/plugins/providers.js',
      // 2026-10-12：src/settings/presets.js 已迁出——导出常量只留 id + nameKey/descriptionKey，
      // 名称/描述进 preset.builtin.* 词条；提示词搬到**未导出**的 BUILTIN_PROMPTS
      //（模型输入，按铁律不进 i18n，规则本来也不查未导出常量）。
      'src/tts/providers.js',
      'src/workspace/plugins/market.js',
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
