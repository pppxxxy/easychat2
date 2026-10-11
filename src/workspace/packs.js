// 声明式扩展包（P2-6）：把工作区的声明式扩展（skills / commands / agents / teams / hooks）
// 打包成一个可导入导出的 JSON 单元——对齐 dsh「插件即一个包」的思路，但**不执行任意代码**，
// 只搬运纯文本扩展文件（移动端 RN/Hermes 运行时动态加载 JS 插件风险高、且不可靠）。
//
// 纯逻辑（schema / 构建 / 解析 / 应用）+ 一层薄 IO（读工作区 / 写工作区）。可 Node 直测。
//
// 安全边界：只允许扩展根目录下的文件进包/落盘（isPackablePath），拒绝路径穿越（..）。

export const PACK_FORMAT = 'easychat2-extension-pack';
export const PACK_VERSION = 1;
export const PACK_NAME_MAX = 48;
export const PACK_DESCRIPTION_MAX = 200;
export const PACK_MAX_FILES = 200;
export const PACK_MAX_FILE_BYTES = 256 * 1024;
export const PACK_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// 可进包的扩展根目录（前缀）与单文件。
export const PACK_ROOTS = Object.freeze([
  '.easychat/skills/',
  '.easychat/commands/',
  '.easychat/agents/',
  '.easychat/teams/',
]);
export const PACK_FILES = Object.freeze(['.easychat/hooks.json']);

function truncate(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 纯函数：路径是否允许进包/落盘（扩展根下、非目录、无穿越）。
export function isPackablePath(path) {
  const value = String(path == null ? '' : path).trim();
  if (!value || value.endsWith('/')) return false;
  if (value.split('/').some(segment => segment === '..' || segment === '')) return false;
  if (PACK_FILES.includes(value)) return true;
  return PACK_ROOTS.some(root => value.startsWith(root) && value.length > root.length);
}

// 纯函数：由扩展文件构造一个包对象（过滤非法/超限；files 输入 [{ path, content }]）。
export function buildPack({ name, description = '', files = [], now = Date.now() } = {}) {
  const entries = [];
  let total = 0;
  for (const file of (Array.isArray(files) ? files : [])) {
    const path = String((file && file.path) || '');
    if (!isPackablePath(path)) continue;
    if (entries.length >= PACK_MAX_FILES) break;
    const content = String((file && file.content) || '');
    if (content.length > PACK_MAX_FILE_BYTES) continue;
    if (total + content.length > PACK_MAX_TOTAL_BYTES) break;
    total += content.length;
    entries.push({ path, content });
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: truncate(name, PACK_NAME_MAX) || 'extension-pack',
    description: truncate(description, PACK_DESCRIPTION_MAX),
    createdAt: Number(now) || Date.now(),
    files: entries,
  };
}

// 纯函数：解析/校验一个包（输入字符串或对象）→ { ok, pack, errors }。
export function parsePack(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      return { ok: false, pack: null, errors: ['不是合法 JSON'] };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, pack: null, errors: ['不是对象'] };
  }
  const errors = [];
  if (data.format !== PACK_FORMAT) errors.push(`format 不匹配（应为 ${PACK_FORMAT}）`);
  if (Number(data.version) > PACK_VERSION) errors.push(`版本过新（${data.version} > ${PACK_VERSION}）`);
  const files = [];
  let total = 0;
  for (const file of (Array.isArray(data.files) ? data.files : [])) {
    const path = String((file && file.path) || '');
    if (!isPackablePath(path)) continue;
    if (files.length >= PACK_MAX_FILES) break;
    const content = String((file && file.content) || '');
    if (content.length > PACK_MAX_FILE_BYTES) continue;
    if (total + content.length > PACK_MAX_TOTAL_BYTES) break;
    total += content.length;
    files.push({ path, content });
  }
  if (files.length === 0) errors.push('包里没有可安装的扩展文件');
  if (errors.length) return { ok: false, pack: null, errors };
  return {
    ok: true,
    pack: {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      name: truncate(data.name, PACK_NAME_MAX) || 'extension-pack',
      description: truncate(data.description, PACK_DESCRIPTION_MAX),
      createdAt: Number(data.createdAt) || Date.now(),
      files,
    },
    errors: [],
  };
}

// 纯函数：序列化成可落盘的 JSON 文本。
export function serializePack(pack) {
  return JSON.stringify(pack, null, 2);
}

// IO：收集工作区里的全部声明式扩展文件 → 包对象。读失败的文件跳过。
export async function collectWorkspacePack(store, characterId, { name, description = '' } = {}) {
  const files = [];
  if (store && typeof store.listWorkspaceFiles === 'function' && typeof store.readWorkspaceFile === 'function') {
    let entries = [];
    try {
      entries = await store.listWorkspaceFiles({ characterId });
    } catch (error) {
      entries = [];
    }
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const path = String(entry || '');
      if (!isPackablePath(path)) continue;
      try {
        const result = await store.readWorkspaceFile({ characterId, path });
        files.push({ path, content: String((result && result.content) || '') });
      } catch (error) {}
    }
  }
  return buildPack({ name, description, files });
}

// IO：把包里的扩展文件写入工作区。默认**不覆盖**已有文件（幂等/防误伤）；
// overwrite=true 才覆盖。返回 { installed, skipped, errors }。
export async function installWorkspacePack(store, characterId, pack, { overwrite = false } = {}) {
  const parsed = parsePack(pack);
  if (!parsed.ok) return { installed: 0, skipped: [], errors: parsed.errors };
  if (!store || typeof store.writeWorkspaceFile !== 'function') {
    return { installed: 0, skipped: [], errors: ['工作区存储不可用'] };
  }
  const installed = [];
  const skipped = [];
  const errors = [];
  for (const file of parsed.pack.files) {
    if (!overwrite) {
      try {
        const existing = await store.readWorkspaceFile({ characterId, path: file.path });
        if (existing && String(existing.content || '').trim()) {
          skipped.push(file.path);
          continue;
        }
      } catch (error) {
        // 读不到 = 视为不存在，继续写。
      }
    }
    try {
      await store.writeWorkspaceFile({ characterId, path: file.path, content: file.content });
      installed.push(file.path);
    } catch (error) {
      errors.push(file.path);
    }
  }
  return { installed: installed.length, skipped, errors };
}
