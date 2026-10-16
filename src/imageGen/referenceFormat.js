// FEAT-AC13 P0-2：参考图格式前置校验（纯函数，Node 直测）。
//
// 事故：HEIC/HEIF 参考图能通过 `isImageLike`（它只查 `image/` 前缀），于是被放行到
// 上游——而 OpenAI 的 `/v1/images/edits` **只收 png/jpg/webp**，返回 400。
// 用户看到的是「生成失败（HTTP 400）」，完全不知道是自己选的图格式不被支持。
//
// 修法（任务书 P0-2）：**宁可拒绝得明白，不要放行后收 400**。在选图那一刻就拦下，
// 并明确告诉用户换 PNG/JPG/WebP。
//
// 边界（有意不做）：不在这里转码。HEIC 转码需要原生能力（Expo 侧没有开箱可用的
// HEIC→PNG 转换），另立案；本轮只做「拒绝 + 指路」。
//
// 为什么独立成模块：判定必须能被**直接断言**（大小写、扩展名回落、不该误伤的格式），
// 而 ImageGenScreen 是 RN 组件，Node 里进不来。

// 上游 /v1/images/edits 实际接受的格式。列在这里是为了让「我们支持什么」可读、可测，
// 而不是散落在提示文案里。
export const I2I_SUPPORTED_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

// 已知会被上游拒收的格式。HEIC/HEIF 是 iOS 默认相册格式，也是本缺陷的现实来源；
// 这里不试图穷举所有格式（那会误伤未来新增的支持项），只钉已知会被拒的一类。
const REJECTED_MIMES = Object.freeze([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

// 扩展名回落：DocumentPicker 在部分 Android 机型上给不出 mimeType（只有文件名），
// 而 `isImageLike` 本身就有扩展名回落，所以这里必须对称地也看扩展名——
// 否则「有 mime 的拦得住、没 mime 的漏过去」，同一个用户换个机型就复现。
const REJECTED_EXTENSIONS = Object.freeze(['heic', 'heif']);

/** 取归一化的小写 mime（去掉 `; charset=` 这类参数）。 */
function normalizeMime(mime) {
  return String(mime === undefined || mime === null ? '' : mime)
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** 取归一化的小写扩展名（无扩展名 → 空串）。 */
function extensionOf(name) {
  const text = String(name === undefined || name === null ? '' : name).trim();
  const dot = text.lastIndexOf('.');
  if (dot === -1 || dot === text.length - 1) return '';
  return text.slice(dot + 1).toLowerCase();
}

/**
 * 参考图是否属于「上游不接受的格式」。
 *
 * 判据：mime 命中拒绝表 → 拒；mime 缺失或不认识时，扩展名命中拒绝表 → 拒。
 * 两条都看是**有意**的（见 REJECTED_EXTENSIONS 的说明）。
 *
 * @param {{ mime?: string, name?: string }} args
 * @returns {boolean}
 */
export function isRejectedReferenceFormat({ mime, name } = {}) {
  const type = normalizeMime(mime);
  if (type) {
    // mime 存在就以它为准：文件名说 .png 但 mime 说 heic 时，mime 更可信
    //（内容类型由系统探测，文件名是用户/应用起的）。
    if (REJECTED_MIMES.includes(type)) return true;
    // mime 存在且**不是**被拒格式 → 不再看扩展名（避免 `photo.heic.png` 这类误伤）。
    return false;
  }
  return REJECTED_EXTENSIONS.includes(extensionOf(name));
}
