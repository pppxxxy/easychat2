// FEAT-AC13 P1-3 / P1-4：openai-relay 的**端点写法自检**与**模型参数兼容**（纯函数，Node 直测）。
//
// 背景（H2）：openai-relay 的 baseUrl 写法敏感——`endpointFromBaseUrl` 只在 baseUrl
// 含 `/images/generations` 时才把它换成 `/images/edits`。于是用户填
// `/v1`、`/images/edits` 或裸域名时行为各异，而设置页的「检测」探的是 `/models`
//（与生成端点无关）——**检测通过不代表改图端点对**。错误要等一次真生成才以远端
// 404 的形式暴露，用户完全不知道是自己地址写错了。
//
// 修法（P1-3）：请求前在**本地**检查 baseUrl，写法不对就直接报错并给出正确形状，
// 让错误发生在本地、带指引，而不是远端 404。
//
// 背景（H3）：gpt-image-1 系模型不接受 `response_format` 参数（传了报
// `Unknown parameter`），而 openai-relay 的 t2i 模板里硬编码了它。
//
// ⚠️ 核实更正（2026-10-16）：任务书说 t2i 模板（L203）与 extraDefaults（L214）
// **都**注入 response_format。对码结果：
//   · L203 模板里的 `response_format: 'b64_json'` 属实，**会**进请求体（经 substitute）；
//   · `extraDefaults` 在全仓**没有任何消费点**（只在这张表里声明，见 grep 结果）——
//     它是**死数据**，不会进请求体。所以「extraDefaults 也注入」这一条不成立。
// 本模块因此只处理**模板**里的 response_format，并把 extraDefaults 的死数据问题
// 如实记录在提交信息里（本轮不改表结构，避免与「不许顺手改」的边界冲突）。

// gpt-image 系：不认 response_format（传了 → 400 Unknown parameter）。
const GPT_IMAGE_PATTERN = /gpt-image/i;

/** 该模型是否属于「不认 response_format」的 gpt-image 系。 */
export function skipsResponseFormat(model) {
  return GPT_IMAGE_PATTERN.test(String(model === undefined || model === null ? '' : model));
}

/**
 * 从请求载荷里摘掉 `response_format`（顶层键）。
 *
 * 只在**顶层**删：OpenAI 的图像接口就是顶层参数；深层同名字段（若某自定义模板
 * 自己嵌了一个）不属于本规则的范围，动了反而越权。
 *
 * 返回**新对象**（不改入参）：调用方可能复用同一载荷做别的判断。
 */
export function withoutResponseFormat(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!Object.prototype.hasOwnProperty.call(payload, 'response_format')) return payload;
  const next = { ...payload };
  delete next.response_format;
  return next;
}

// 端点自检的判定结果（调用方据此决定文案；纯数据，便于断言）。
export const ENDPOINT_ISSUES = Object.freeze({
  OK: 'ok',
  MISSING_IMAGES_PATH: 'missing-images-path',
  EDITS_ONLY: 'edits-only',
});

/**
 * 自检 openai-relay 的 baseUrl 写法。
 *
 * 判据（与 providers.js 的 endpointFromBaseUrl 完全同源——那里只在含
 * `/images/generations` 时换 `/images/edits`）：
 *  - 含 `/images/generations` → OK（t2i 直接用，i2i 换成 edits）；
 *  - 含 `/images/edits` → EDITS_ONLY（改图能走，但**文生图会打到 edits 端点**，
 *    必然失败；要如实告诉用户，不能假装没问题）；
 *  - 两者都不含（如 `/v1`、裸域名）→ MISSING_IMAGES_PATH（两条路都会打到错的地方）。
 *
 * @param {string} baseUrl
 * @returns {string} ENDPOINT_ISSUES 之一
 */
export function inspectImageEndpoint(baseUrl) {
  const url = String(baseUrl === undefined || baseUrl === null ? '' : baseUrl).trim();
  if (!url) return ENDPOINT_ISSUES.MISSING_IMAGES_PATH;
  if (url.includes('/images/generations')) return ENDPOINT_ISSUES.OK;
  if (url.includes('/images/edits')) return ENDPOINT_ISSUES.EDITS_ONLY;
  return ENDPOINT_ISSUES.MISSING_IMAGES_PATH;
}
