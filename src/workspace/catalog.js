// 工作区「环境与配置下载」目录（纯数据 + 生成函数，零依赖，Node 直测）。
//
// 目标：让工作区角色在手机上真正跑得起来——git 提交需要 .gitconfig，工程
// 仓库需要 .gitignore/.editorconfig，国内网络下装依赖需要镜像配置。这些文件
// 由面板一键生成并写入当前工作区角色的沙盒（走 store.writeWorkspaceFile，
// 自动进历史改动记录），角色随后可以用 GitHub MCP 工具把它们提交到仓库。
//
// 内容全部内置（不联网）：模板是短文本，内置可离线、可测试、内容可控。
// 任意 URL 下载走面板的自定义下载入口（https 校验 + 大小上限）。

export const CATALOG_CATEGORIES = Object.freeze(['git', 'mirror', 'docs']);

const GITIGNORE_CONTENT = `# ---- 通用 ----
.DS_Store
Thumbs.db
*.log
*.tmp
.env
.env.*
!.env.example

# ---- Node / 前端 ----
node_modules/
dist/
build/
coverage/
*.tsbuildinfo
.npm/
.eslintcache

# ---- Python ----
__pycache__/
*.py[cod]
.venv/
venv/
.pytest_cache/
.mypy_cache/
*.egg-info/

# ---- Android ----
*.apk
*.aab
local.properties
.gradle/
build/
captures/
.externalNativeBuild
.cxx/
`;

const EDITORCONFIG_CONTENT = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.py]
indent_size = 4

[*.{md,markdown}]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
`;

const NPMRC_CONTENT = `# npmmirror（国内镜像）：registry 与二进制预编译包一起换，装依赖才真的快
registry=https://registry.npmmirror.com/
disturl=https://npmmirror.com/mirrors/node/
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
sass_binary_site=https://npmmirror.com/mirrors/node-sass/
phantomjs_cdnurl=https://npmmirror.com/mirrors/phantomjs/
`;

const PIP_CONF_CONTENT = `# 清华 PyPI 镜像（国内加速）；pip 配置文件路径：Linux/macOS ~/.pip/pip.conf 或 ~/.config/pip/pip.conf，Windows %APPDATA%\\pip\\pip.ini
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn
timeout = 60
`;

const COMMIT_CONVENTION_CONTENT = `# 提交信息规范（Conventional Commits）

格式：<type>(<scope>): <subject>

## type
- feat     新功能
- fix      修复
- docs     仅文档
- refactor 重构（不改行为）
- test     测试
- chore    构建/依赖/杂项
- perf     性能

## 规则
1. subject 用一句话说清「这次改了什么」，中文即可，不加句号；
2. 一个提交只做一件事：修复与功能分开提交；
3. 破坏性变更在 subject 加 ! 并在正文说明迁移方式（feat!:)；
4. 正文（可空）解释为什么改，不逐行复述 diff。

## 示例
feat(chat,memory): 上下文占用估算与 80% 自动压缩
fix(books): docx 解压按正文实际字节设 32MB 上限（zip 炸弹面）
`;

const PR_TEMPLATE_CONTENT = `## 改动说明

<!-- 这次改了什么、为什么改（一句话 + 展开说明） -->

## 改动范围

<!-- 涉及的模块/文件，是否有破坏性变更 -->

## 自测

- [ ] 本地跑过 lint / 单测
- [ ] 新增逻辑有对应测试
- [ ] 涉及原生/平台行为时在真机验证过

## 关联

<!-- 关联 issue / 讨论链接 -->
`;

function buildGitconfig(inputs) {
  const name = String(inputs && inputs.userName || '').trim() || '你的名字';
  const email = String(inputs && inputs.userEmail || '').trim() || 'you@example.com';
  return `# Git 全局配置模板（提交身份）。放到仓库根目录会覆盖全局同名文件；
# 也可以把内容合进 ~/.gitconfig（手机上经 GitHub MCP 提交到仓库时用它声明身份）。
[user]
	name = ${name}
	email = ${email}

[init]
	defaultBranch = main

[core]
	autocrlf = input
	quotepath = false

[pull]
	rebase = false

[alias]
	st = status
	lg = log --oneline --graph --decorate -20
	last = log -1 HEAD --stat
`;
}

export const CATALOG_ITEMS = Object.freeze([
  {
    id: 'gitignore',
    category: 'git',
    file: '.gitignore',
    titleKey: 'workspace.panel.catalog.gitignore.title',
    descKey: 'workspace.panel.catalog.gitignore.desc',
    content: GITIGNORE_CONTENT,
  },
  {
    id: 'gitconfig',
    category: 'git',
    file: '.gitconfig',
    titleKey: 'workspace.panel.catalog.gitconfig.title',
    descKey: 'workspace.panel.catalog.gitconfig.desc',
    inputs: [
      { key: 'userName', labelKey: 'workspace.panel.catalog.gitconfig.name', placeholderKey: 'workspace.panel.catalog.gitconfig.nameHint' },
      { key: 'userEmail', labelKey: 'workspace.panel.catalog.gitconfig.email', placeholderKey: 'workspace.panel.catalog.gitconfig.emailHint' },
    ],
    build: buildGitconfig,
  },
  {
    id: 'editorconfig',
    category: 'git',
    file: '.editorconfig',
    titleKey: 'workspace.panel.catalog.editorconfig.title',
    descKey: 'workspace.panel.catalog.editorconfig.desc',
    content: EDITORCONFIG_CONTENT,
  },
  {
    id: 'npmrc',
    category: 'mirror',
    file: '.npmrc',
    titleKey: 'workspace.panel.catalog.npmrc.title',
    descKey: 'workspace.panel.catalog.npmrc.desc',
    content: NPMRC_CONTENT,
  },
  {
    id: 'pipconf',
    category: 'mirror',
    file: 'pip.conf',
    titleKey: 'workspace.panel.catalog.pipconf.title',
    descKey: 'workspace.panel.catalog.pipconf.desc',
    content: PIP_CONF_CONTENT,
  },
  {
    id: 'commit-convention',
    category: 'docs',
    file: 'COMMIT_CONVENTION.md',
    titleKey: 'workspace.panel.catalog.commit.title',
    descKey: 'workspace.panel.catalog.commit.desc',
    content: COMMIT_CONVENTION_CONTENT,
  },
  {
    id: 'pr-template',
    category: 'docs',
    file: 'PULL_REQUEST_TEMPLATE.md',
    titleKey: 'workspace.panel.catalog.pr.title',
    descKey: 'workspace.panel.catalog.pr.desc',
    content: PR_TEMPLATE_CONTENT,
  },
]);

export function catalogItemsByCategory(category) {
  return CATALOG_ITEMS.filter(item => item.category === category);
}

export function findCatalogItem(id) {
  return CATALOG_ITEMS.find(item => item.id === id) || null;
}

// 生成内容：有 build 的（需输入）走 build，否则取内置 content。
export function buildCatalogContent(item, inputs) {
  if (!item) throw new Error('catalog item not found');
  if (typeof item.build === 'function') return item.build(inputs || {});
  return String(item.content || '');
}
