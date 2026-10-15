// FEAT-AC3：悬浮球头像来源解析的**纯逻辑层**（零 RN 依赖，Node 直测）。
//
// 为什么单独一个文件（本仓反复踩过的同一课）：overlayAvatar 的消费点
//（配置快照 / 设置卡 / 推送）都牵涉 storage 与原生桥，在 Node 里 import 不了；
// 而「三模式各自该给出什么 uri」恰恰是这次唯一需要动脑的判定——必须能直测。
//
// 关键设计（任务书 P0-3）：**双值**输出。
// scope 切换（聊天 ⇄ 工作区）发生在**原生侧**（OverlayService.toggleChatScope 已核实
// 不回调 JS），所以 JS 一次性把两个 scope 各自的头像都算好推过去，原生按当前 scope 自选。
// 这样不需要新开「原生 → JS 反向询问」这条本来不存在的通道。

/**
 * 解析悬浮球头像来源。
 *
 * @param {object} args
 * @param {string} args.mode                  'default' | 'character' | 'custom'
 * @param {string} [args.customUri]           自定义图片 uri（custom 模式用）
 * @param {string} [args.characterAvatarUri]  当前角色头像 uri（character 模式用）
 * @returns {{ chatAvatarUri: string, workspaceAvatarUri: string }}
 *   空串 = 「回退 App 图标」（原生侧收到空串就当默认）。
 */
export function resolveOverlayAvatarSource({
  mode,
  customUri = '',
  characterAvatarUri = '',
} = {}) {
  const normalizedMode = String(mode || 'default');
  const custom = String(customUri || '').trim();
  const character = String(characterAvatarUri || '').trim();

  let chatAvatarUri = '';
  if (normalizedMode === 'custom') {
    // 自定义模式两个 scope 都用同一张图（用户选的是「这个 app 的头像」，
    // 不该因为切到工作区就变回 App 图标——那不是用户选的东西）。
    chatAvatarUri = custom;
  } else if (normalizedMode === 'character') {
    // 跟随角色：聊天 scope 用角色头像；角色没头像时留空 → 原生回退 App 图标。
    chatAvatarUri = character;
  }

  // 工作区 scope：角色头像在这里没有意义（工作区会话未必要角色）。
  // character 模式下回退 App 图标；custom 模式仍用自定义图（见上）。
  const workspaceAvatarUri = normalizedMode === 'custom' ? custom : '';

  return { chatAvatarUri, workspaceAvatarUri };
}

/**
 * 角色头像 uri 的归一（任务书留的「归一位置」）。
 *
 * 为什么需要：角色头像在 app 内是 `FileSystem.documentDirectory` 下的绝对
 * `file://` uri（已核实：所有写入路径都走 copyAsync 到 documentDirectory，
 * 见 cardForge/media.js 与 CharacterDetailScreen.js）。但历史数据/导入卡片
 * 可能带相对路径——原生的 contentResolver.openInputStream 认不了裸相对路径，
 * 会静默回退 App 图标（用户看到「跟随角色不生效」却没有任何提示）。
 *
 * 归一规则：
 *   · 空 → ''（不猜）
 *   · 已带 scheme（file:// / content:// / http(s):// / data:）→ 原样
 *   · 以 / 开头的绝对路径 → 补 file://
 *   · 其余（相对路径）→ 拼到 documentDirectory 下并补 file://
 *
 * @param {string} uri                 角色头像字段的原始值
 * @param {string} [documentDirectory] expo FileSystem.documentDirectory（含尾斜杠）
 */
export function normalizeCharacterAvatarUri(uri, documentDirectory = '') {
  const raw = String(uri || '').trim();
  if (!raw) return '';
  // 已有 scheme：原样（content:// 与 http(s):// 都交给原生 contentResolver 处理）
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  const base = String(documentDirectory || '').trim();
  if (!base) {
    // 拿不到 documentDirectory：只能按绝对路径处理（补 file://）。
    // 相对路径在这里无法可靠还原——返回空交由调用方回退，好过给一个读不了的 uri。
    return raw.startsWith('/') ? `file://${raw}` : '';
  }
  // ⚠️ base 本身通常已带 file:// 前缀（expo 的 documentDirectory 就是 file:///...），
  // 所以**不能**无条件再补一次——那会拼出 `file://file:///...`（实测踩到）。
  // 判据：base 已带 scheme 就用它，否则补 file://。
  const baseWithScheme = /^[a-z][a-z0-9+.-]*:/i.test(base)
    ? base
    : `file://${base}`;
  // 绝对路径**直接补 scheme**，不拼 base（拼了就变成 base + 绝对路径，实测踩到）。
  if (raw.startsWith('/')) return `file://${raw}`;
  const normalizedBase = baseWithScheme.endsWith('/') ? baseWithScheme : `${baseWithScheme}/`;
  return `${normalizedBase}${raw}`;
}
