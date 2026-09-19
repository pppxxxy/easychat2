# 开发者指南

## 项目目的

EasyChat2 是一个单机运行的移动端 AI 聊天应用，让用户用自备的 API Key 与兼容 OpenAI 协议的模型对话，并提供角色人设与角色卡导入能力。

**核心职责**:
- 提供暗色主题的三页移动端界面：聊天、角色、设置
- 将 API 配置、角色库与聊天记录持久化在设备本机
- 陈列多个角色并支持切换，每个角色对应独立会话
- 兼容 OpenAI Chat Completions 协议，支持自定义地址与模型
- 支持从 PNG / JSON 角色卡导入人设
- 展示助手 Markdown 回复，并对请求错误提供可复制的诊断信息

**相关系统**:
- 外部大模型 HTTP 接口 - 通过用户配置的地址调用
- `parsecard` - 解析角色卡文件
- EAS Build / GitHub Actions - 产出 Android APK

**许可**: AGPL-3.0-or-later

## 环境搭建

### 前置条件

- Node.js 20（与 CI 一致）
- npm（仓库使用 `npm ci` 与 lockfile）
- 真机上的 Expo Go，或 Android 原生构建环境（Java 17 + Android SDK）
- 可选：全局 `eas-cli` 用于云构建

### 安装

```bash
# 克隆仓库
git clone https://github.com/pppxxxy/easychat2
cd easychat2

# 安装依赖
npm install
```

> 仓库内 `.npmrc` 设置了 `legacy-peer-deps=true`，以兼容依赖树中的 peer 版本。

### 环境变量

应用本身不使用 `.env` 或构建期注入的密钥。API Key 由用户在应用内「设置」页填写，并仅保存在设备本机 `AsyncStorage`。切勿把真实密钥写入代码或提交到仓库。

### 运行

```bash
# 启动 Expo 开发服务器（默认）
npm run start

# 直接在 Android 设备/模拟器打开
npm run android

# Web 目标（非主要目标）
npm run web
```

用 Expo Go 扫码即可在真机调试。首次使用需在「设置」页填写 API 地址、模型与 API Key。

## 构建 APK

### GitHub Actions（无需 EAS）

触发仓库的 **Build APK on GitHub** 工作流（`workflow_dispatch`）。该流程会：

1. 安装 Node 20、Java 17 与 Android SDK
2. `npm ci` 安装依赖
3. `npx expo prebuild --platform android --clean` 生成原生工程
4. 将 release 构建签名临时指向 debug keystore，并写入 Gradle JVM 参数
5. `./gradlew assembleRelease` 产出 APK，并作为 Artifact 上传（保留 14 天）

### EAS 云构建

触发 **Build APK** 工作流，需要仓库 Secret `EXPO_TOKEN`。构建配置见 `eas.json` 的 `preview` profile（Android `buildType: apk`）。

本地预览包：

```bash
# 安装 EAS CLI
npm install -g eas-cli

# 构建预览 APK
npm run build:apk
```

### EAS 构建调试

**EAS Build Debug** 工作流接受一个 `build_id` 输入，拉取该构建的元数据与日志，剔除 ANSI 转义后抽取关键错误上下文，并上传为 Artifact，便于排查云构建失败。

## 开发工作流

### 依赖变更与校验

本项目未配置 ESLint、TypeScript 或单元测试。改动后的最低验证方式：

```bash
# 校验依赖树与 lockfile 一致性（CI 使用）
npm ci

# 启动开发服务器，验证界面与热更新
npm run start
```

若改动了会被打包的代码，建议在合并前至少确认 `npm run start` 能正常加载应用，并手动覆盖受影响的功能路径。

### 未定义引用检查（重要）

Metro/Babel **不做未定义变量检查**，只做语法与模块解析。因此「调用了某个函数/组件但忘记 import」或「模块级函数引用了组件作用域内的变量」这类错误**能顺利打包**，却在运行时抛 `ReferenceError` 并导致白屏闪退。历史上曾因此出现启动即崩的回归。

改动界面代码后，务必运行一次未定义引用检查：

```bash
# 生成一次性 flat config（不写入仓库）
cat > /tmp/eslint.check.mjs <<'EOF'
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        React: 'readonly', global: 'readonly', Promise: 'readonly', require: 'readonly',
        module: 'readonly', exports: 'readonly', process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', FormData: 'readonly',
        XMLHttpRequest: 'readonly', AbortController: 'readonly', Buffer: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly',
        __DEV__: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];
EOF

npx eslint --config /tmp/eslint.check.mjs App.js src/*.js src/*/*.js
```

输出为空即通过；任何 `no-undef` 都必须修复后才能提交。

**高频踩坑点**：

1. **忘记 import 新加入的原生组件或 hook**：例如在 `ChatScreen` 使用 `ActivityIndicator`、`useTheme` 却未 import。
2. **主题化改造遗漏模块级组件**：`styles`/`theme` 从模块常量改为 `useTheme()` + `createStyles()` 工厂后，**同文件内的每个顶层组件与顶层辅助函数都必须各自调用 `useTheme()`**。只给主组件加会导致其子组件渲染时 `ReferenceError`。
3. **模块级辅助函数引用组件作用域变量**：如 `renderHighlightedText(text, keyword)` 直接使用 `styles.highlightText`。应把 `styles` 作为参数传入。
4. **计数式检查不可靠**：用 `grep -c "useTheme()"` 与 `grep -c "const styles"` 比对数量**无法发现**遗漏——必须按「顶层组件/函数」逐个切分检查，或直接依赖 `no-undef`。

**自检命令（按顶层定义切分）**：

```bash
# 列出所有使用 styles./theme. 但没有 useTheme() 的顶层组件/函数
for f in src/*.js; do
  node -e "
    const fs=require('fs');const s=fs.readFileSync('$f','utf8');
    const lines=s.split('\n');
    const comps=[];
    lines.forEach((l,i)=>{ if(/^(function|const)\s+[A-Z][A-Za-z]*\s*(=|\()/.test(l) && !/^const\s+[A-Z_]+\s*=/.test(l)) comps.push({name:l.trim().slice(0,55), line:i+1}); });
    for(let k=0;k<comps.length;k++){
      const start=comps[k].line-1;
      const end=(k+1<comps.length)?comps[k+1].line-1:Math.min(lines.length, comps[k].line+400);
      const body=lines.slice(start,end).join('\n');
      const uses=/\bstyles\.|\btheme\.(colors|id)/.test(body);
      if(uses && !/useTheme\(\)/.test(body)) console.log('$f', comps[k].line, comps[k].name);
    }
  "
done
```

### 分支与提交

- 主分支为 `main`，生产就绪代码
- 提交信息采用 Conventional Commits 前缀：`feat`、`fix`、`refactor`、`chore`、`docs`
- 近期提交示例：
  - `feat: render assistant replies as markdown`
  - `fix: harden character state and message persistence`
  - `refactor: move character save alerts out of AppContext`
  - `chore: tidy deps, add prebuild script, and set up Buffer polyfill`

### 变更检查清单

- [ ] `npm ci` 通过，lockfile 已同步提交
- [ ] 改动界面后运行「未定义引用检查」（`npx eslint --config /tmp/eslint.check.mjs ...`）且无输出
- [ ] 主题化或新增 `useTheme` 时，确认同文件每个顶层组件/函数都调用了 `useTheme()`
- [ ] 涉及界面时用 `npm run start` 手动验证
- [ ] 新增 `AsyncStorage` 调用已做异常捕获
- [ ] 未把任何密钥、令牌写入代码或文档
- [ ] 涉及打包依赖时确认 Metro / Buffer 垫片仍生效

## 常见任务

### 添加新的持久化字段

**需修改的文件**:
1. `src/storage.js` - 在对应默认值对象中加入字段，并在读取时合并回退
2. 消费该字段的界面 - 读取并渲染

**步骤**:
1. 在 `DEFAULT_API_CONFIG` 或 `DEFAULT_CHARACTER` 中补默认值
2. 保证 `getXxx` 返回值与默认值合并，避免旧数据缺字段
3. 运行时记得 catch 存储异常

### 添加新标签页

**需修改的文件**:
1. `src/<NewScreen>.js` - 新建界面组件
2. `App.js` - 在 `Tab.Navigator` 中增加 `Tab.Screen`

**步骤**:
1. 参考现有 Screen 的暗色样式常量
2. 在 `App.js` 导入并注册，设置 `name` 作为标签标题
3. 若需全局状态，通过 `useApp()` 获取

### 接入新模型或接口地址

**无需改代码**。在应用「设置」页填写 `baseUrl`、`model`、`apiKey`。`api.js` 的 `normalizeChatUrl` 支持根地址、`/v1` 结尾与完整 `/v1/chat/completions` 三种写法。

### 调整角色卡字段映射

**需修改的文件**:
1. `src/CharacterScreen.js` 的 `extractCardFields` - 决定从角色卡取哪些字段
2. 同文件的 `parseJsonCard` / `parsePngCard` - 决定解析路径

**步骤**:
1. 修改 `extractCardFields` 的字段回退顺序
2. 保持名称缺失时返回空值，由调用方提示解析失败
3. 用真实 PNG 与 JSON 角色卡各验证一次

### 修改消息持久化维度

**需修改的文件**:
1. `src/storage.js` 的 `messagesKey` / `LEGACY_MESSAGES_KEY`
2. `src/ChatScreen.js` 的加载与保存副作用

**注意**: 修改键名会使旧数据不可见，如需兼容应在读取时增加兜底分支。

### 修复请求错误展示

**流程**:
1. 在 `ChatScreen` 的 `onSend` catch 中定位错误来源
2. `api.js` 负责把 HTTP 错误转成可读消息
3. 展示前必须经过 `maskSecrets`，未脱敏原文只写入 `errorRawRef`
4. 验证展开、折叠与复制三条路径

## 编码规范

### 文件组织

- 界面组件按功能命名，一个文件一个默认导出组件：`ChatScreen.js`、`CharacterScreen.js`
- 非界面模块使用小写文件名：`api.js`、`storage.js`
- 全局状态放在 `src/context/` 下

### 命名

| 类型 | 约定 | 示例 |
|------|------|------|
| 组件文件 | PascalCase | `ChatScreen.js` |
| 工具文件 | camelCase | `storage.js` |
| 组件 | PascalCase | `ErrorBubble` |
| 函数/变量 | camelCase | `sendChatMessage`、`persistableSnapshot` |
| 常量 | SCREAMING_SNAKE | `MESSAGES_KEY_PREFIX`、`DEFAULT_CHARACTER` |

### 错误处理

- `storage.js` 的 `readJson` 对读取失败返回回退值，调用方无需重复处理读取异常
- 写入类调用（`saveApiConfigs`、`saveCharacter`、`saveMessages`）会向上抛出，由界面层决定提示方式
- Context 只负责回滚状态并重抛，不直接弹窗
- 报错展示前一律经过 `maskSecrets`

### 样式

- 每个界面文件底部使用 `StyleSheet.create`
- 统一暗色配色：背景 `#1a1a2e`、卡片 `#2d2d44`、主色 `#6c63ff`、次要文字 `#aaa`
- 禁用态统一用 `opacity: 0.45`

### Markdown 渲染

- 仅助手消息使用 `react-native-markdown-display`
- 用户消息与系统报错保持纯 `Text`，避免误解析
- 样式常量集中在 `ChatScreen.js` 的 `markdownStyles`
