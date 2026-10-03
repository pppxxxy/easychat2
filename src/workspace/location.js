// 工作区根目录的解析与「用户自选文件夹」（SAF）支持策略。
//
// 纯函数 + 依赖注入（saf 由调用方传），零原生依赖，可 Node 直测。
//
// 两种根：
// - 应用私有根：`documentDirectory/workspace/<characterId>/`，零权限、始终可用；
// - 用户选定的本地文件夹（Android SAF）：用户选一次，系统授权持久化，
//   之后读写都在该文件夹下的 `<characterId>/` 子目录里。
//
// **为什么必须有策略**：SAF 是逐 URI 授权、且只认 tree / document 两类 URI。
// expo-file-system/legacy 能用 content:// 读（readAsStringAsync/getInfoAsync 都有
// SAF 分支），但 **readDirectoryAsync 对 SAF 直接抛 UnsupportedSchemeException**——
// 也就是「列出目录」这件事在 legacy 下做不到。所以外部根不能复用 legacy 后端，
// 必须走新 API（safStore.js）——那套内部是 DocumentFile 的 list/create，能列。
// 另外 **无 root 的 shell 访问不了 content://**，故外部根下命令执行一律禁用。

export const WORKSPACE_ROOT_KINDS = Object.freeze({
  APP: 'app',
  SAF: 'saf',
});

// 单条路径最长 240（与 paths.js 一致），文件夹显示名截断到 80。
export const MAX_DISPLAY_NAME = 80;

function cleanString(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

export function normalizeWorkspaceLocation(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (source.kind !== WORKSPACE_ROOT_KINDS.SAF) {
    return { kind: WORKSPACE_ROOT_KINDS.APP, uri: '', name: '' };
  }
  const uri = cleanString(source.uri, 2000);
  // 只认 content://：file:// 之类的路径要么根本拿不到（分区存储下应用无权读），
  // 要么会被拼进字符串路径绕过 SAF 语义。存下来只会让后面每次操作都失败。
  if (!uri || !isSafTreeUri(uri)) return { kind: WORKSPACE_ROOT_KINDS.APP, uri: '', name: '' };
  return {
    kind: WORKSPACE_ROOT_KINDS.SAF,
    uri,
    name: cleanString(source.name, MAX_DISPLAY_NAME),
  };
}

// 用户选的 tree URI 是否是 SAF 形态（content:// 且不是普通文件 content URI）。
// 只做前缀判断：真正能不能用由系统授权决定，这里防的是把 file:// 或空串当外部根存下来。
export function isSafTreeUri(uri) {
  const value = cleanString(uri, 2000);
  return value.startsWith('content://');
}

// 根目录 uri（带结尾 /）。sandboxDirectory 会在其后拼 <characterId>/。
export function resolveWorkspaceRoot(location, appRoot) {
  const base = String(appRoot || '');
  const normalized = normalizeWorkspaceLocation(location);
  if (normalized.kind !== WORKSPACE_ROOT_KINDS.SAF) return base;
  return normalized.uri.endsWith('/') ? normalized.uri : `${normalized.uri}/`;
}

// 工作区能力矩阵：如实描述「当前根」下各项能力到底有没有。
//
// 两种根现在都由各自的后端支持完整读写与列目录（外部根走 safStore.js 的
// Directory/File 新 API），差别只剩命令执行：
// **无 root 的 shell 碰不到 SAF 的 content:// 路径**，所以外部根下一律禁用。
//
// 这是给 UI 如实告知用的，不是给工具兜底的判断——工具照常注册，
// 注册与否由 native.js 按开关决定，界面说明由本矩阵驱动。
export function workspaceCapabilities({ location, shellAvailable = false } = {}) {
  const normalized = normalizeWorkspaceLocation(location);
  const external = normalized.kind === WORKSPACE_ROOT_KINDS.SAF;
  return {
    rootKind: external ? WORKSPACE_ROOT_KINDS.SAF : WORKSPACE_ROOT_KINDS.APP,
    external,
    canList: true,
    canRead: true,
    canWrite: true,
    canEdit: true,
    // 外部根下即便装了原生 shell 也用不了：shell 只能看到应用沙盒与公开路径。
    canShell: Boolean(shellAvailable) && !external,
    shellUnavailableReason: external
      ? 'EXTERNAL_ROOT_NO_SHELL'
      : (shellAvailable ? '' : 'SHELL_NOT_AVAILABLE'),
  };
}
