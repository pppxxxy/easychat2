// URL 的 path / query 拆分与回拼——零依赖叶子模块。
//
// 存在的理由（先例：src/vectorMemory/providers.js:41-48，该域已按此修好）：
// 端点「后缀判定」必须只看**路径**部分。Azure 部署地址形如
//   https://x.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15
// 整串做 /embeddings$/ 判定必然不中（结尾是 api-version），于是端点被再追加一次，
// 拼成 .../embeddings?api-version=2023-05-15/embeddings → 404。
// ⇒ 同型缺陷 = 「后缀正则/endsWith 作用在含 query 的整串上 → 判定必然失败 →
//    端点被追加进 query 值里」。本模块把那条修法的**语义原样**抽成公共函数，
//    供 apiProtocols / network / transcription / imageGen / agent 各域共用，
//    避免每个域再手写一遍（此前 8 处手写、6 处不切 query）。
//
// ⚠️ 本文件**不得 import 任何东西**（零依赖叶子，供各域共用，且不得参与循环依赖）。
// ⚠️ 只用于**网络端点**。文件系统路径**不要**走这里：`?` 是合法文件名字符，
//    对路径切 query 反而会截断合法文件名（见 workspace/**、shell.js 等）。

// 按**第一个** '?' 拆分（与 providers.js 的 indexOf('?') 口径一致）：
//   - path：第一个 '?' 之前的部分，并去掉**尾部斜杠**（`/`、`//`…全部去净）；
//   - query：第一个 '?' 起的全部内容，**含前导 '?'**；没有 '?' 时为 ''。
// 返回对象而不是数组：调用点两处都要用，具名取值更不容易把两者接反。
export function splitUrlQuery(url) {
  const text = String(url == null ? '' : url);
  const queryIndex = text.indexOf('?');
  const path = (queryIndex === -1 ? text : text.slice(0, queryIndex)).replace(/\/+$/, '');
  const query = queryIndex === -1 ? '' : text.slice(queryIndex);
  return { path, query };
}

// 回拼：query 原样接回（含前导 '?'；空串则只返回 path）。
// 刻意**不做**任何归一（不加 '?'、不去重），保证 split→join 是无损往返。
export function joinUrlQuery(path, query) {
  return `${String(path == null ? '' : path)}${String(query == null ? '' : query)}`;
}
