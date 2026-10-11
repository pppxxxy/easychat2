// 扩展导入来源解析：把「一行输入」判定成「从哪儿取文件」。
//
// 纯函数、零依赖、Node 直测（与 repoImport.js / catalog.js 同风格）。UI 与 agent 工具
// 共用同一份判定，避免两处各写一遍正则后漂移（一处认 npm:foo，另一处不认）。
//
// 支持四类来源（对应界面上三种入口 + 兜底）：
//   github —— owner/repo、仓库页 URL、带 /tree/<ref>/<subpath> 的深链
//   npm    —— npm:<pkg>[@ver]、npmjs 包页、registry 元数据 URL、裸包名、@scope/name
//   paste  —— 直接粘一段 JSON（MCP 配置 / 扩展包 / 插件清单）
//   url    —— 其它 http(s) 地址：按「单个原始文件」抓（GitHub /blob/ 链接会转成 raw）
//
// 判定顺序有讲究：先看是不是 JSON 文本（粘贴），再认显式前缀（npm:），然后才靠形状猜
// 包名/仓库名——否则一个叫 `npm` 的目录名会被误判成包名。

// 各来源的 id 顺序即界面上的芯片顺序。
export const IMPORT_SOURCE_KINDS = Object.freeze(['github', 'npm', 'paste', 'url']);

// 界面文案不硬编码中文：这里只带 i18n key，由渲染层 t() 取值（仓库既有 labelKey 惯例）。
export const IMPORT_METHODS = Object.freeze([
  { id: 'github', labelKey: 'workspace.import.method.github', placeholderKey: 'workspace.import.placeholder.github' },
  { id: 'npm', labelKey: 'workspace.import.method.npm', placeholderKey: 'workspace.import.placeholder.npm' },
  { id: 'paste', labelKey: 'workspace.import.method.paste', placeholderKey: 'workspace.import.placeholder.paste' },
]);

const OWNER_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const BARE_PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SCOPED_PACKAGE_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const NPM_SPEC_RE = /^npm:(\S+)$/i;
const NPM_PAGE_RE = /^https?:\/\/(?:www\.)?npmjs\.(?:com|org)\/package\/([^/?#\s]+)(?:\/v\/([^/?#\s]+))?/i;
const NPM_REGISTRY_RE = /^https?:\/\/registry\.npmjs\.org\/(.+?)(?:\/(?:latest|\d[^/]*))?$/i;
const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#\s]+)((?:\/[^?#\s]*)?))?\/?(?:[?#].*)?$/i;

function decode(value) {
  try {
    return decodeURIComponent(String(value == null ? '' : value));
  } catch (error) {
    return String(value == null ? '' : value);
  }
}

// 「包名@版本」→ { name, version }。npm 的 @scope 前缀要与版本分隔符区分开：
// 只有第一个非首位的 '@' 才是版本分隔符（@scope/pkg@1.2.3）。
export function splitPackageSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  if (at > 0) return { name: raw.slice(0, at), version: raw.slice(at + 1) };
  return { name: raw, version: '' };
}

// 「owner/repo」或 GitHub 仓库页/深链 URL → { owner, repo, ref, subpath }；认不出返回 null。
export function parseGithubTarget(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const urlMatch = raw.match(GITHUB_URL_RE);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: String(urlMatch[2] || '').replace(/\.git$/i, ''),
      ref: decode(urlMatch[3] || ''),
      subpath: decode(urlMatch[4] || '').replace(/^\/+|\/+$/g, ''),
    };
  }
  const pair = raw.replace(/^@/, '').match(OWNER_REPO_RE);
  if (!pair) return null;
  // 排除明显的 npm scope 写法（@scope/name 已在上面被 @ 剥掉，这里防 'npm/foo' 之类误判）
  return { owner: pair[1], repo: String(pair[2]).replace(/\.git$/i, ''), ref: '', subpath: '' };
}

// GitHub 的 /blob/<ref>/<path> 页面链接 → codeload 原始文件 URL（直接抓文本）。
export function githubBlobToRawUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  const match = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/blob\/([^/?#\s]+)((?:\/[^?#\s]*)?)\/?(?:[?#].*)?$/i);
  if (!match) return '';
  const path = decode(match[4] || '').replace(/^\/+/, '');
  if (!path) return '';
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${decode(match[3])}/${path}`;
}

// 输入 → 来源描述符。永不抛错：认不出时 kind='invalid' 且带 reason（供界面提示）。
export function parseImportSource(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { kind: 'invalid', reason: 'empty' };

  // 1) 粘贴的配置文本。JSON 用 JSON.parse 判真伪，避免把「以 { 开头的普通句子」当配置；
  //    以 frontmatter 开头的当技能正文（用户直接粘一个 SKILL.md 的常见用法）。
  if (/^---\r?\n/.test(raw)) return { kind: 'paste', path: 'SKILL.md', text: raw };
  if (/^[{[]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { kind: 'paste', path: 'pasted.json', text: raw };
    } catch (error) {
      return { kind: 'invalid', reason: 'badJson' };
    }
    return { kind: 'invalid', reason: 'badJson' };
  }

  // 2) 显式 npm 前缀：npm:foo / npm:@scope/foo@1.2.3
  const explicit = raw.match(NPM_SPEC_RE);
  if (explicit) {
    const spec = splitPackageSpec(explicit[1]);
    if (!spec || !spec.name) return { kind: 'invalid', reason: 'badPackage' };
    return { kind: 'npm', package: spec.name, version: spec.version };
  }

  // 3) npm 包页 / registry 元数据 URL
  const page = raw.match(NPM_PAGE_RE);
  if (page) {
    const spec = splitPackageSpec(decode(page[1]));
    if (!spec || !spec.name) return { kind: 'invalid', reason: 'badPackage' };
    return { kind: 'npm', package: spec.name, version: decode(page[2] || '') || spec.version };
  }
  const registry = raw.match(NPM_REGISTRY_RE);
  if (registry) {
    const spec = splitPackageSpec(decode(registry[1]));
    if (spec && spec.name) return { kind: 'npm', package: spec.name, version: spec.version };
  }

  // 4) GitHub 单文件链接：转 raw 当普通 URL 抓（仓库快照抓整包太重）
  const blobRaw = githubBlobToRawUrl(raw);
  if (blobRaw) return { kind: 'url', url: blobRaw, label: raw };

  // 5) GitHub 仓库（URL 或 owner/repo）
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(raw)) {
    const target = parseGithubTarget(raw);
    if (target && target.owner && target.repo) return { kind: 'github', ...target };
    return { kind: 'invalid', reason: 'badRepo' };
  }
  if (OWNER_REPO_RE.test(raw) && !raw.startsWith('@')) {
    const target = parseGithubTarget(raw);
    if (target) return { kind: 'github', ...target };
  }

  // 6) 其它 http(s)：单文件原始地址
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw };

  // 7) 裸包名（含 @scope/name）。放在最后：它最宽松，先判会把 owner/repo 吃掉。
  if (BARE_PACKAGE_RE.test(raw) || SCOPED_PACKAGE_RE.test(raw)) {
    const spec = splitPackageSpec(raw);
    if (spec && spec.name) return { kind: 'npm', package: spec.name, version: spec.version };
  }

  return { kind: 'invalid', reason: 'unrecognized' };
}
