// 多 agent 扩展格式适配：把「一堆文件」翻译成本应用的扩展资产。
//
// 这里是「兼容 Claude Code / ZCode / Codex / DeepSeek harness」的落点：识别各家各自的
// 目录与文件约定，映射到本应用的等价物。纯函数、零 IO、Node 直测。
//
// 识别表（源布局 → 本应用目标）：
//   **/SKILL.md（含 .claude/skills/<n>/SKILL.md）      → .easychat/skills/<n>/SKILL.md
//   **/commands/<n>.md（含 .claude/commands/）          → .easychat/commands/<n>.md
//   **/agents/<n>.md（含 .claude/agents/）              → .easychat/agents/<n>.md
//   含 mcpServers / mcp / servers 键的 JSON             → MCP 服务
//     （.mcp.json、opencode.json、claude_desktop_config.json 等；**只看内容不看文件名**，
//       这样粘贴进来的配置也能认，各家的命名差异也不再需要逐条枚举）
//   .claude-plugin/plugin.json                          → 记录插件身份，其技能/命令/代理/MCP 由上面的规则各自接管
//   easychat2-extension-pack JSON                       → 扩展包（packs.js 的格式）
//   本应用插件清单 JSON（id + name + 非空 tools/slots）  → 插件（plugins/manifest.js 的格式）
//
// 三类「认得出但装不了」的明确记账（不静默丢）：
//   - stdio 型 MCP（command/args/env）：本应用只有 Streamable HTTP 传输（mcp/client.js）；
//   - Codex 的 config.toml：TOML 超出最小 frontmatter 解析器的能力，请改用 JSON 形态导入；
//   - 非 http(s) 的 MCP endpoint。
//
// 为什么不复用 markdownFrontmatter 判技能：它只认单行 key:value，够用（name/description
// 就是全部需要的）。技能正文原样搬运，不做改写——改写会丢脚本/模板等资源引用。

import { validateManifest } from '../plugins/manifest.js';
import { PACK_FORMAT, parsePack } from '../packs.js';
import { splitMarkdownFrontmatter } from '../markdownFrontmatter.js';

export const ADAPTER_LIMITS = Object.freeze({
  MAX_FILES: 3000,
  MAX_FILE_CHARS: 512 * 1024,
  MAX_SKILLS: 60,
  MAX_COMMANDS: 60,
  MAX_AGENTS: 30,
  MAX_MCP_SERVERS: 20,
  MAX_PLUGINS: 12,
  MAX_PACKS: 5,
});

export const SKILLS_DIR = '.easychat/skills';
export const COMMANDS_DIR = '.easychat/commands';
export const AGENTS_DIR = '.easychat/agents';

// 含 mcpServers 键的配置文件名（Claude Code / Claude Desktop / 通用写法）。
const MCP_SERVERS_FILENAMES = new Set(['.mcp.json', 'mcp.json', 'mcp_servers.json', 'claude_desktop_config.json']);
// 含 mcp 键的 agent 配置文件（opencode / ZCode）。
const AGENT_CONFIG_FILENAMES = new Set(['opencode.json', 'opencode.jsonc', 'zcode.json', 'zcode.jsonc']);
// Claude Code 插件清单所在目录名。
const CLAUDE_PLUGIN_DIR = '.claude-plugin';

const CJK_SAFE_ID_MAX = 48;

function baseName(path) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || '';
}

function dirName(path) {
  const parts = String(path || '').split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

// 目录名/包名 → 本应用的 id 形态（小写、非字母数字折成 '-'、去首尾、限长）。
// 与 plugins/manifest.js 的 normalizePluginId 同口径，但不 import 它——本模块要能
// 独立测，且「适配层不该依赖目标格式的校验实现」。
export function slugify(value, max = CJK_SAFE_ID_MAX) {
  const slug = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug.slice(0, max);
}

// 宽松 JSON：先按标准 JSON 解，失败再按 JSONC 的常见写法清理一次（注释 + 尾逗号）。
// 只做「删行首注释」「删块注释」「删尾逗号」三件事，不做完整 JSONC 实现——
// 正则式清理有误伤风险（URL 里的 //），所以只在标准解析失败后才走这条。
export function parseJsonLoose(text) {
  const raw = String(text == null ? '' : text);
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {}
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (error) {
    return { ok: false, value: null };
  }
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value == null ? '' : value).trim());
}

// 取主机名。刻意不用 `new URL()`：RN 的 URL 实现是残缺 polyfill（hostname 可能缺失），
// 而这里只需要一个稳定的小写主机名。
function hostOf(value) {
  const match = String(value == null ? '' : value).match(/^https?:\/\/([^/?#\s:]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function normalizeHeaders(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const headers = {};
  Object.entries(source).forEach(([key, value]) => {
    const name = String(key || '').trim();
    const text = typeof value === 'string' ? value.trim() : '';
    if (!name || !text || text.length > 512) return;
    headers[name] = text;
  });
  return headers;
}

// 单个 MCP 服务条目（Claude / opencode / ZCode 三种写法）→ 本应用的服务记录。
// 认不出（stdio / 缺地址 / 非 http）时返回 { skipped: reason }，由调用方记账。
export function adaptMcpServer(name, raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const url = String(source.url || source.endpoint || source.serverUrl || '').trim();
  if (!url) {
    // Claude/opencode 的本地服务写法：command + args（本应用没有 stdio 传输）
    const hasCommand = Boolean(source.command);
    return { skipped: hasCommand ? 'stdio' : 'noEndpoint' };
  }
  if (!isHttpUrl(url)) return { skipped: 'notHttp' };
  const headers = normalizeHeaders(source.headers);
  // Authorization: Bearer <token> 抽成 mcpToken：本应用的密钥字段走系统钥匙串，
  // 留在 headers 里会以明文进磁盘（storage/secretStore 只保护 mcpToken）。
  let mcpToken = '';
  Object.keys(headers).forEach(key => {
    if (!/^authorization$/i.test(key)) return;
    const match = headers[key].match(/^bearer\s+(.+)$/i);
    if (!match) return;
    mcpToken = match[1].trim();
    delete headers[key];
  });
  const id = slugify(name) || slugify(hostOf(url)) || 'mcp';
  return {
    server: {
      id,
      name: String(name || id).trim().slice(0, 60),
      endpoint: url,
      authMethod: 'token',
      mcpToken,
      headers,
      enabled: source.enabled !== false && source.disabled !== true,
    },
    // type 只用来提示：本应用的客户端按 Streamable HTTP 发 POST，legacy SSE 端点未必可用
    sse: String(source.type || source.transport || '').toLowerCase() === 'sse',
  };
}

function pickMcpContainer(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  for (const key of ['mcpServers', 'mcp_servers', 'mcp', 'servers']) {
    const value = json[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

// 判断一份 JSON 是不是本应用的插件清单：必须 id + name + 至少一个非空 tools/slots。
// 不加「非空」这一条，任何带 id/name 的配置对象都会通过 validateManifest（slots/tools
// 都是可选项），把无关 JSON 误判成插件。
export function isNativePluginManifest(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (!validateManifest(json).ok) return false;
  const tools = Array.isArray(json.tools) ? json.tools.length : 0;
  const slots = Array.isArray(json.slots) ? json.slots.length : 0;
  return tools > 0 || slots > 0;
}

// 导入时的文件筛选：一次仓库/包动辄上千文件，只拉「可能承载扩展」的那些。
// 判定只看路径不看内容——它决定下载量，必须在下载前就能算出来。
// 取「宁宽勿漏」：多拉一个无关 JSON 的代价是几 KB，漏掉一个插件清单的代价是导入失败。
const NOISE_JSON = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'deno.json', 'deno.jsonc', 'bower.json', 'composer.json',
]);

export function isRelevantImportPath(path) {
  const clean = String(path == null ? '' : path).replace(/^\.?\//, '');
  if (!clean) return false;
  const base = baseName(clean).toLowerCase();
  if (base === 'skill.md') return true;
  if (/(^|\/)(commands|agents)\/[^/]+\.md$/.test(clean.toLowerCase())) return true;
  if (MCP_SERVERS_FILENAMES.has(base) || AGENT_CONFIG_FILENAMES.has(base)) return true;
  if (base === 'plugin.json') return true;
  // 扩展包/插件清单一般就在根或一层子目录里；再深的多是构建产物，不值得全量拉。
  if (base.endsWith('.json') && !NOISE_JSON.has(base) && clean.split('/').length <= 3) return true;
  return false;
}

function pushCapped(list, item, max, notes, kindLabel) {  if (list.length >= max) {
    if (!notes.some(note => note.reason === 'capped' && note.kind === kindLabel)) {
      notes.push({ kind: kindLabel, reason: 'capped', limit: max });
    }
    return false;
  }
  list.push(item);
  return true;
}

// files: [{ path, content }]（path 用 '/' 分隔，相对来源根）。
// 返回 { plugins, packs, skills, commands, agents, mcpServers, notes, counts }。
export function detectArtifacts(files, { sourceLabel = '' } = {}) {
  const result = {
    plugins: [],
    packs: [],
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    notes: [],
    counts: { files: 0, skippedOversize: 0 },
  };
  const list = (Array.isArray(files) ? files : []).slice(0, ADAPTER_LIMITS.MAX_FILES);
  const fallbackName = slugify(sourceLabel) || 'imported';

  for (const file of list) {
    const path = String((file && file.path) || '').replace(/^\.?\//, '');
    const content = typeof (file && file.content) === 'string' ? file.content : '';
    if (!path) continue;
    result.counts.files += 1;
    if (content.length > ADAPTER_LIMITS.MAX_FILE_CHARS) {
      result.counts.skippedOversize += 1;
      continue;
    }
    const base = baseName(path);
    const lower = base.toLowerCase();
    const lowerPath = String(path).toLowerCase();
    const parent = dirName(path).toLowerCase();

    // 1) Claude Code 插件清单：记录身份，其内容由后面的规则各自接管
    if (lower === 'plugin.json' && parent === CLAUDE_PLUGIN_DIR) {
      const parsed = parseJsonLoose(content);
      const meta = parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
      result.notes.push({
        kind: 'claudePlugin',
        name: String(meta.name || slugify(dirName(dirName(path))) || '').trim(),
        reason: 'claudePluginBundle',
      });
      continue;
    }

    // 2) 一切 JSON：按「扩展包 → 插件清单 → MCP 配置」的顺序认。
    // 刻意**不看文件名**只认内容：粘贴进来的配置没有文件名，而 MCP 配置的三种命名
    // （.mcp.json / opencode.json / claude_desktop_config.json）内容形状是同一个。
    if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
      const parsed = parseJsonLoose(content);
      const json = parsed.ok ? parsed.value : null;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        if (json.format === PACK_FORMAT) {
          const pack = parsePack(json);
          if (pack.ok) {
            pushCapped(result.packs, { pack: pack.pack, name: pack.pack.name, origin: path }, ADAPTER_LIMITS.MAX_PACKS, result.notes, 'pack');
          } else {
            result.notes.push({ kind: 'pack', name: base, reason: 'invalidPack', origin: path });
          }
          continue;
        }
        if (isNativePluginManifest(json)) {
          pushCapped(result.plugins, { manifest: json, id: json.id, name: json.name, origin: path }, ADAPTER_LIMITS.MAX_PLUGINS, result.notes, 'plugin');
          continue;
        }
        const container = pickMcpContainer(json);
        if (container) {
          Object.entries(container).forEach(([name, raw]) => {
            const adapted = adaptMcpServer(name, raw);
            if (adapted.skipped) {
              result.notes.push({ kind: 'mcpServer', name, reason: adapted.skipped, origin: path });
              return;
            }
            if (adapted.sse) result.notes.push({ kind: 'mcpServer', name, reason: 'sse', origin: path });
            pushCapped(result.mcpServers, { ...adapted.server, origin: path }, ADAPTER_LIMITS.MAX_MCP_SERVERS, result.notes, 'mcpServer');
          });
        }
      }
      continue;
    }

    // 3) 技能：任意位置的 SKILL.md
    if (lower === 'skill.md') {
      const parsed = splitMarkdownFrontmatter(content);
      const meta = parsed.meta || {};
      const owner = dirName(path);
      // 目录名优先当 slug（.claude/skills/<n>/SKILL.md → n）；根级 SKILL.md 用
      // frontmatter 的 name，再退回来源名——保证同一来源里的多个技能不撞名。
      const slug = slugify(owner && !/^skills?$/i.test(owner) ? owner : (meta.name || fallbackName));
      if (!slug) {
        result.notes.push({ kind: 'skill', name: base, reason: 'badName', origin: path });
        continue;
      }
      pushCapped(result.skills, {
        slug,
        name: String(meta.name || owner || slug).trim().slice(0, 48),
        description: String(meta.description || '').trim().slice(0, 160),
        path: `${SKILLS_DIR}/${slug}/SKILL.md`,
        content,
        origin: path,
      }, ADAPTER_LIMITS.MAX_SKILLS, result.notes, 'skill');
      continue;
    }

    // 4) 斜杠命令 / 子代理档案
    const markdown = lowerPath.match(/(^|\/)(commands|agents)\/([^/]+)\.md$/);
    if (markdown) {
      const isCommand = markdown[2] === 'commands';
      const name = slugify(markdown[3]);
      if (!name) continue;
      const parsed = splitMarkdownFrontmatter(content);
      const meta = parsed.meta || {};
      const entry = {
        name,
        displayName: String(meta.name || markdown[3]).trim().slice(0, 48),
        description: String(meta.description || '').trim().slice(0, 160),
        path: `${isCommand ? COMMANDS_DIR : AGENTS_DIR}/${name}.md`,
        content,
        origin: path,
      };
      if (isCommand) {
        pushCapped(result.commands, entry, ADAPTER_LIMITS.MAX_COMMANDS, result.notes, 'command');
      } else {
        pushCapped(result.agents, entry, ADAPTER_LIMITS.MAX_AGENTS, result.notes, 'agent');
      }
    }
  }

  return result;
}

// 预览/结果用的计数摘要（不含内容，便于直接进 UI 与工具输出）。
export function summarizeArtifacts(artifacts) {
  const source = artifacts && typeof artifacts === 'object' ? artifacts : {};
  const count = key => (Array.isArray(source[key]) ? source[key].length : 0);
  return {
    plugins: count('plugins'),
    packs: count('packs'),
    skills: count('skills'),
    commands: count('commands'),
    agents: count('agents'),
    mcpServers: count('mcpServers'),
    notes: count('notes'),
    total: count('plugins') + count('packs') + count('skills') + count('commands') + count('agents') + count('mcpServers'),
  };
}

export function hasArtifacts(artifacts) {
  return summarizeArtifacts(artifacts).total > 0;
}
