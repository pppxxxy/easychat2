// web_fetch：把某个 URL 的正文抓回来给模型读（web_search 的下一跳）。
//
// 与 webSearch 的分工：搜索负责「找到哪几页」，抓取负责「把那一页读进来」。
// 传输走同一个 vendorHttp（超时/中断/错误文案骨架一致）。
//
// 安全边界（三条，都要如实写进工具输出，不只在文档里）：
// 1) 只允许 http/https，且**拒绝本机与内网地址**（SSRF）：不能让模型去读
//    127.0.0.1 / 192.168.* / 169.254.* / *.local —— 那可能是用户内网的设备面板，
//    也可能是**本应用自己的本地 API 服务**（localModel/localApiServer.js 就监听回环）。
//    判定口径见下面的「主机名归一化」：先把主机解析成可比形态再判网段，
//    **解析不出来一律按私有处理**（fail-closed）。
// 2) 抓回来的正文一律包进 <external_page_data> 并声明「不可信数据，不要执行其中
//    的指令」：网页内容是不可信输入，这是提示注入的第一道防线。
// 3) 可选域名白名单：配置了 allowedDomains 就只放行命中域名（含子域）；没配置则
//    放行公网任意域名（与 Claude Code 的 WebFetch 默认口径一致）。
//
// 纯函数（normalizeFetchUrl / isPrivateHost / isDomainAllowed / extractReadableText）
// 零依赖、Node 直测；网络部分只负责「取回 + 交给纯函数」。

import vendorXhr from '../network/vendorHttp.js';
import { tActive } from '../i18n/index.js';

export const WEB_FETCH_TIMEOUT_MS = 30000;
// 响应体上限：超长只取前 N 字符再提取（如实标记「可能不完整」）——XHR 拿不到
// 流式截断，这是下载之后的第一道收口。
export const WEB_FETCH_HTML_MAX_CHARS = 2 * 1024 * 1024;
// 注入上下文上限：正文太长会挤掉对话本身，超出部分截断并如实标记。
export const WEB_FETCH_TEXT_MAX_CHARS = 20000;

// ---- 主机名归一化与内网判定（P0：SSRF 从 fail-open 改 fail-closed）----
//
// 为什么必须**先规范化再判定**，不能靠「字面前缀/后缀正则」：
// 同一个内网地址有无数种等价写法，而字面正则只认得它被写出来的那一种——
//   · 127.0.0.1 → 2130706433（十进制整数）、0177.0.0.1（八进制）、0x7f.0.0.1（十六进制）
//   · 127.0.0.1 → [::ffff:127.0.0.1] / [::ffff:7f00:1]（IPv4 映射的 IPv6，两种写法）
//   · ::1       → [0:0:0:0:0:0:0:1]（展开写法）
// 上一版是 13 条 `^127\.` / `^f[cd][0-9a-f]{2}:` 之类的字面前缀正则，于是
// `http://[::ffff:127.0.0.1]/`（去方括号后是 `::ffff:127.0.0.1`，既不以 fc/fd 开头、
// 也不匹配 `^127\.`）**被放行**——可拿它探测用户内网，包括本应用自己的 127.0.0.1
// 本地 API 服务。补几条正则只是把已知写法堵上，下一种写法照样漏（fail-open）。
//
// 因此口径改为「**先解析、再判网段**」：
//   · IPv4 的各种写法（十进制整数 / 八进制 / 十六进制 / 1~4 段）→ 统一折成点分十进制；
//   · IPv6（含 ::ffff: 映射与点分十进制尾巴）→ 统一折成 8 个 16 位段（可比形态）；
//   · 域名 → 小写（尾点去掉，`router.local.` 与 `router.local` 是同一个名字）；
//   · **解析不出来一律按私有处理**：宁可错拦一个写法古怪的域名，也不能漏放内网地址。
// 手写解析的原因见 normalizeFetchUrl 的注释（Hermes 上 URL 实现不完整）。
const PRIVATE_HOST_NAMES = Object.freeze(['localhost']);
const PRIVATE_HOST_SUFFIXES = Object.freeze(['.local', '.internal', '.localhost']);

// 纯函数：单个 IPv4 段 → 整数。支持十进制、八进制（前导 0）、十六进制（0x）。
// 前导 0 后跟 8/9（非法八进制）判为「解析不出来」，不去猜它想写十进制——
// 猜错就等于让「我判它是公网、系统连的是内网」的分叉重新出现。
function parseIpv4Part(part) {
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^0+$/.test(part)) return 0;
  if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
  return null;
}

// 纯函数：IPv4 字面量 → 32 位无符号整数；非法返回 null。
// 段数 1~4（a / a.b / a.b.c / a.b.c.d），与浏览器 URL 解析、inet_aton 同口径：
// 末段可占的位数随段数变化（1 段 32 位、2 段 24 位、3 段 16 位、4 段 8 位）。
function parseIpv4Int(text) {
  const value = String(text === undefined || text === null ? '' : text);
  const parts = value.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    const num = parseIpv4Part(part);
    if (num === null) return null;
    nums.push(num);
  }
  const lastMax = [0xffffffff, 0xffffff, 0xffff, 0xff][nums.length - 1];
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 0xff) return null;
  }
  if (nums[nums.length - 1] > lastMax) return null;
  let total = 0;
  for (let i = 0; i < nums.length - 1; i += 1) total = (total * 256) + nums[i];
  total = (total * (lastMax + 1)) + nums[nums.length - 1];
  return total >>> 0;
}

function ipv4ToDotted(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

// 纯函数：这个主机名「看起来是数字地址」吗？
// 只有数字形态才走 IPv4 解析——否则 `example.com` 会被当成「解析失败」而误拦。
// 判据取「纯十进制 / 0x 十六进制 / 点分的数字段」，与浏览器认得的写法对齐；
// 看着像数字却解析不出来（如 `1.2.3.4.5`、`08.1.1.1`）由调用方按私有处理。
function looksLikeIpv4(text) {
  if (/^[0-9]+$/.test(text)) return true;
  if (/^0[xX][0-9a-fA-F]*$/.test(text)) return true;
  return text.includes('.') && /^[0-9a-fA-FxX.]+$/.test(text) && /^[0-9]/.test(text);
}

// 纯函数：IPv6 字面量 → 8 个 16 位段；非法返回 null。
// 支持 `::` 压缩、完整展开、区域号（%eth0，判定无意义故去掉）与末尾点分十进制
// （`::ffff:127.0.0.1` 先折成 `::ffff:7f00:1`，两种写法从此同一条路径）。
function parseIpv6Groups(text) {
  let value = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (!value || !value.includes(':')) return null;
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = parseIpv4Int(tail);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const readGroups = list => {
    const out = [];
    for (const part of list) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const headGroups = readGroups(head);
  const restGroups = readGroups(rest);
  if (!headGroups || !restGroups) return null;
  const fill = 8 - headGroups.length - restGroups.length;
  // 有 `::` 时必须真的压掉至少一段；没有 `::` 时必须正好 8 段。
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...headGroups, ...new Array(fill).fill(0), ...restGroups];
}

// 纯函数：8 个 16 位段 → 小写压缩形态（最长的一段连续 0 折成 `::`）。
function formatIpv6(groups) {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    const isZero = i < groups.length && groups[i] === 0;
    if (isZero) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > bestLength) {
        bestLength = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  const hex = group => group.toString(16);
  if (bestLength < 2) return groups.map(hex).join(':');
  const head = groups.slice(0, bestStart).map(hex).join(':');
  const tail = groups.slice(bestStart + bestLength).map(hex).join(':');
  return `${head}::${tail}`;
}

// 纯函数：IPv4（32 位整数）是否属于本机 / 内网 / 保留网段。**按网段判，不看写法**。
function isPrivateIpv4Int(value) {
  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;
  if (first === 0 || first === 10 || first === 127) return true;   // 0/8（含 0.0.0.0）、10/8、127/8
  if (first === 100 && second >= 64 && second <= 127) return true; // 100.64/10 运营商级 NAT
  if (first === 169 && second === 254) return true;                // 169.254/16 链路本地（云元数据）
  if (first === 172 && second >= 16 && second <= 31) return true;  // 172.16/12
  if (first === 192 && second === 168) return true;                // 192.168/16
  if (first >= 224) return true;                                   // 224/4 组播 + 240/4 保留
  return false;
}

// 纯函数：IPv6（8 个 16 位段）是否私有。
function isPrivateIpv6Groups(groups) {
  const first = groups[0];
  const zeroHead = groups.slice(0, 5).every(group => group === 0);
  // IPv4 映射（::ffff:a.b.c.d / ::ffff:7f00:1）与 IPv4 兼容 / 未指定 / 回环
  // （::、::1、::a.b.c.d）一律折回 IPv4 判定——同一个地址的两种写法必须得到
  // 同一个结论，否则映射写法就是现成的绕过口。
  if (zeroHead && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isPrivateIpv4Int((((groups[6] << 16) | groups[7]) >>> 0));
  }
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址（ULA）
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃，仍按私有）
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
  return false;
}

// 纯函数：主机名 → 可比形态 { kind, value, ipv4?, groups? }。
// kind ∈ name | ipv4 | ipv6 | invalid；invalid = 解析不出来（调用方必须按私有处理）。
function classifyHost(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value) return { kind: 'invalid', value: '' };
  if (value.includes(':')) {
    const groups = parseIpv6Groups(value);
    if (!groups) return { kind: 'invalid', value };
    return { kind: 'ipv6', value: formatIpv6(groups), groups };
  }
  if (looksLikeIpv4(value)) {
    const ipv4 = parseIpv4Int(value);
    if (ipv4 === null) return { kind: 'invalid', value };
    return { kind: 'ipv4', value: ipv4ToDotted(ipv4), ipv4 };
  }
  return { kind: 'name', value };
}

// 纯函数：归一化后的主机是否本机 / 内网。**fail-closed**：解析不出来也算私有。
//
// ⚠️ 已知缺口（DNS rebinding，**尚未堵死，不要以为这里已经安全**）：
// 本判定全程发生在 **DNS 解析之前**，判的是**字面主机名**，不是**实际连过去的对端 IP**。
// `kind === 'name'`（普通域名）只比对字面 `localhost` 与 `.local / .internal /
// .localhost` 三条后缀；对 `http://attacker.example/`（三条后缀都不命中）这里会
// **放行**，随后 OkHttp 才去做 DNS 解析 —— 若该域名的 A 记录指向 `127.0.0.1`，
// 请求就落在回环上（本仓 `localModel/localApiServer.js` 就监听回环），内网内容被读回。
// 这就是「判定对象 ≠ 实际连接对象」：我们判的是字符串，系统连的是解析结果。
//
// 三个必须记住的结论：
//   1) 这一条**不需要任何重定向**，一次解析就够了；
//   2) 因此 runWebFetch 里基于 `xhr.responseURL` 的最终 URL 复核**对它完全无效**
//      —— 没有跳转时 responseURL 就等于原 URL，复核必然通过；
//   3) **JS 层拿不到对端 IP**（XHR 不暴露 socket 地址），所以纯 JS 无法闭环。
//
// 确定性修法（**需 native 侧改动，本波只留档、未实现**）：在 Android 侧用
// `OkHttpClientProvider.setOkHttpClientFactory`（ReactAndroid 的
// `OkHttpClientProvider.kt:28` 是 public）注入一个带 DNS **解析后复核**的
// `Dns`/`Interceptor`（解析出 IP 后按网段复核，命中内网即拒绝），
// 或 iOS 侧对应改 `RCTHTTPRequestHandler`。产品层面的等价缓解是
// **默认要求白名单**（allowedDomains 非空才允许抓取）——那属于产品决策，
// 不在本次修复范围。在 native 拦截器落地之前，这里的 fail-closed 只覆盖
// 「字面就是内网地址」，**不覆盖「域名解析后才变成内网」**。
// 先例：src/localModel/adapter.js:278 的 fail-closed 也是在拿不到确定信息时
// 选择拒绝而不是放行；本缺口拿不到对端 IP，属于「信息不足」而非「判定通过」。
function isPrivateHostInfo(info) {
  if (info.kind === 'invalid') return true;
  if (info.kind === 'ipv4') return isPrivateIpv4Int(info.ipv4);
  if (info.kind === 'ipv6') return isPrivateIpv6Groups(info.groups);
  if (PRIVATE_HOST_NAMES.includes(info.value)) return true;
  return PRIVATE_HOST_SUFFIXES.some(suffix => info.value.endsWith(suffix));
}

// 没有主机名也一律拒绝（不可信）。
export function isPrivateHost(host) {
  return isPrivateHostInfo(classifyHost(host));
}

// 纯函数：从 authority 里取出主机部分（去 userinfo、去端口、去 IPv6 方括号）。
// 不能用「最后一个 `:数字` 一刀切」：`[::1]:8080` 要按方括号切，而 `::1` 这种
// 不带方括号的写法里 `:1` 是地址的一部分、不是端口（旧实现切掉后得到 `:`，
// 判定随之失真）。只有「整串仅一个冒号」时才敢把冒号后面当端口。
function extractAuthorityHost(authority) {
  const text = String(authority === undefined || authority === null ? '' : authority);
  const hostPart = text.includes('@') ? text.slice(text.lastIndexOf('@') + 1) : text;
  if (hostPart.startsWith('[')) {
    const end = hostPart.indexOf(']');
    return end < 0 ? null : hostPart.slice(1, end);
  }
  const colon = hostPart.indexOf(':');
  if (colon >= 0 && hostPart.indexOf(':', colon + 1) < 0 && /^[0-9]*$/.test(hostPart.slice(colon + 1))) {
    return hostPart.slice(0, colon);
  }
  return hostPart;
}

// 纯函数：URL 归一 + 准入。返回 { ok:true, url, host } 或 { ok:false, reason }。
// reason ∈ empty | invalid | scheme | private —— 调用方据此给不同错误文案。
// 不依赖全局 URL（Hermes 上的实现不完整），手写解析：
//   <scheme>://<authority><path?query#hash>
// host 返回的是**归一化形态**（IPv4 点分十进制 / IPv6 小写压缩 / 域名小写），
// 白名单比对与错误文案都用它；url 保持用户原样写法的 authority，不改写请求语义。
export function normalizeFetchUrl(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { ok: false, reason: 'empty' };
  const match = /^(https?):\/\/([^/?#\s]+)([^\s]*)$/i.exec(text);
  if (!match) {
    // 区分「协议不对」与「http(s) 但写坏了」：前者提示换协议，后者提示补全地址。
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(text);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
    if (scheme && scheme !== 'http' && scheme !== 'https') return { ok: false, reason: 'scheme' };
    return { ok: false, reason: 'invalid' };
  }
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const rest = match[3] || '';
  const hostPart = extractAuthorityHost(authority);
  if (hostPart === null) return { ok: false, reason: 'invalid' };
  const info = classifyHost(hostPart);
  // 解析不出来按**私有**处理（fail-closed）：`1.2.3.4.5`、`08.1.1.1` 这类
  // 「看着像数字地址却解析不出来」的写法不该被当成普通域名放行。
  if (info.kind === 'invalid') return { ok: false, reason: 'private' };
  // 域名形态必须含字母数字：`...` / `-` 这类不是主机名（IP 形态已由解析保证合法）。
  if (info.kind === 'name' && !/[a-z0-9]/i.test(info.value)) return { ok: false, reason: 'invalid' };
  // 判定走归一化后的形态：整数/八进制/十六进制/::ffff: 映射等写法在这里被折平。
  if (isPrivateHostInfo(info)) return { ok: false, reason: 'private' };
  return { ok: true, url: `${scheme}://${authority}${rest}`, host: info.value };
}

// 白名单解析：接受数组或逗号/空格/分号分隔的字符串，容忍写成完整 URL。
export function parseAllowedDomains(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/[\s,，;；]+/);
  return list
    .map(item => String(item || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, ''))
    .filter(Boolean);
}

// 纯函数：域名是否放行。白名单为空 = 放行全部（公网域名已在 normalizeFetchUrl 过滤）。
export function isDomainAllowed(host, allowedDomains) {
  const list = parseAllowedDomains(allowedDomains);
  if (list.length === 0) return true;
  const value = String(host || '').toLowerCase();
  return list.some(domain => value === domain || value.endsWith(`.${domain}`));
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', times: '×', middot: '·', copy: '©',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
};

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch (error) {
    return '';
  }
}

export function decodeHtmlEntities(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const value = NAMED_ENTITIES[String(name).toLowerCase()];
      return value === undefined ? match : value;
    });
}

// 纯函数：HTML → 可读正文 + 标题。
// 取舍：不做完整的 DOM 解析（RN 里没有 DOM，引 htmlparser2 只为提取不值当）；
// 用「去脚本样式 → 块级标签变换行 → 去标签 → 解实体 → 逐行收敛」这套够用的规则。
// 明确不做：正文抽取算法（Readability 那类）——它需要完整 DOM 与大量启发式，
// 代价远超收益；这里宁可多留一点导航文字，也不冒险把正文删掉。
export function extractReadableText(html, { maxChars = WEB_FETCH_TEXT_MAX_CHARS } = {}) {
  const raw = String(html === undefined || html === null ? '' : html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim()
    : '';
  let body = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*\/?>/gi, ' ');
  // 块级标签 → 换行：保住段落结构，别把整页压成一行。
  body = body.replace(
    /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|blockquote|pre|figure|figcaption|dd|dt|hr)\b[^>]*>/gi,
    '\n'
  );
  body = body.replace(/<[^>]*>/g, ' ');
  const text = decodeHtmlEntities(body)
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const limit = Math.max(1, Math.floor(Number(maxChars)) || WEB_FETCH_TEXT_MAX_CHARS);
  const truncated = text.length > limit;
  return { title, text: truncated ? text.slice(0, limit) : text, truncated };
}

function createAbortError() {
  const error = new Error(tActive('error.webFetch.aborted'));
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

// 纯函数：重定向后的**最终 URL** 复核（SSRF 第二道闸，修法 (b)）。
//
// 背景：上面的 normalizeFetchUrl 只判**初始 URL**，而 RN 的 XMLHttpRequest
// **默认自动跟随 3xx**，且 JS 层关不掉：
//   · Libraries/Network/XMLHttpRequest.js:633-647 的 sendRequest 参数表**没有**
//     `followRedirects` 位；
//   · Android 侧 OkHttpClientProvider.kt:48-51 用 OkHttp 默认值，全仓 grep
//     `followRedirects` **0 命中**。
// ⇒ `https://attacker.example/r` 回 `302 Location: http://127.0.0.1:<port>/...`
// 时，OkHttp 会自己跟过去并把内网内容读回来（本仓 localModel/localApiServer.js
// 就监听回环）。所以「只判初始 URL」= 判定对象 ≠ 实际连接对象。
//
// 为什么用 responseURL：XMLHttpRequest.js:343-354 确认最终 URL 会被回填到
// `xhr.responseURL`（没有该字段时是 `delete`，取到 undefined）。这是 JS 层
// 唯一能拿到的「实际落点」信号。
//
// ⚠️ **必须留档的边界（不要以为这条堵死了重定向绕过）**：
// `responseURL` 是**最终 URL**，不是**跳转链**。只复核最终 URL 会漏掉
// `A(公网) → B(内网) → C(公网)` 这种「中途落到内网、最终又跳回公网」的链
// —— OkHttp 会把整条链跟完，中途那次请求已经打到内网上了，而最终 URL 看着是公网。
// 本复核只堵「**最终 URL 落在内网**」；中途落到内网再跳回公网**仍可绕过**。
// 彻底堵死需 **native 侧**：用 `OkHttpClientProvider.setOkHttpClientFactory`
// （ReactAndroid 的 `OkHttpClientProvider.kt:28` 是 public）注入一个
// `followRedirects(false)` 的 client，再由 JS 自己逐跳校验 Location。
// **本波只做 (b)（JS 层可做的部分），不声称已彻底堵死。**
//
// 口径与初始判定完全一致（同一套 classifyHost/isPrivateHostInfo）：不另立标准，
// 否则两条闸门会出现「初始判定说私网、复核说公网」的分叉。**fail-closed**：
// 拿不到 responseURL（undefined / 空串 / 解析不出来）时不阻断——见下面注释说明
// 为什么这里不能 fail-closed，以及它对应的残余风险。
export function isPrivateRedirectTarget(rawUrl) {
  const text = String(rawUrl === undefined || rawUrl === null ? '' : rawUrl).trim();
  // 取不到最终 URL 时**放行**（返回 false）：RN 在 responseURL 缺失时是
  // `delete this.responseURL`，属正常路径（例如某些重定向实现不回报），
  // 把它当私网会让所有这类响应直接失败（过度拦截，比原缺口更糟）。
  // 残余风险如实记录：此时退回到「只有初始 URL 判定」这一层保护。
  if (!text) return false;
  const normalized = normalizeFetchUrl(text);
  // 复用 normalizeFetchUrl 的同一套判定（含 fail-closed 口径）：它已经会因
  // 私网主机返回 reason==='private'。所以「最终 URL 落在内网」在这里就是 !ok。
  // 解析不出来（reason 为 invalid / scheme）同样按私有处理 —— fail-closed，
  // 与 normalizeFetchUrl 里 `info.kind === 'invalid'` 的处理保持一致。
  return !normalized.ok;
}

// IO：抓取 + 提取。准入失败在**发请求之前**抛出（不发无谓的请求，也不泄露内网探测）。
export async function runWebFetch({ url, allowedDomains = '', signal = null } = {}) {
  const normalized = normalizeFetchUrl(url);
  if (!normalized.ok) {
    const key = normalized.reason === 'private'
      ? 'error.webFetch.privateHost'
      : (normalized.reason === 'scheme' ? 'error.webFetch.badScheme' : 'error.webFetch.badUrl');
    const error = new Error(tActive(key));
    error.fetchReason = normalized.reason;
    throw error;
  }
  if (!isDomainAllowed(normalized.host, allowedDomains)) {
    const error = new Error(tActive('error.webFetch.domainBlocked', { host: normalized.host }));
    error.fetchReason = 'blocked';
    throw error;
  }
  // 重定向复核用的槽位：parse 在 onload 里跑，是唯一能同时看到「最终 URL」与
  // 「响应体」的时刻。复核不通过就抛错，错误经 onParseError 冒泡出去。
  const redirectGuard = { finalUrl: '' };
  const html = await vendorXhr({
    method: 'GET',
    url: normalized.url,
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
    signal,
    timeoutMs: WEB_FETCH_TIMEOUT_MS,
    defaultTimeoutMs: WEB_FETCH_TIMEOUT_MS,
    onTimeoutError: () => new Error(tActive('error.webFetch.timeout')),
    onAbortError: () => createAbortError(),
    onAbortEventError: () => new Error(tActive('error.webFetch.aborted')),
    onNetworkError: () => new Error(tActive('error.webFetch.networkFailed')),
    onHttpError: status => new Error(tActive('error.webFetch.httpFailed', { status })),
    parse: xhr => {
      // 修法 (b)：请求**已经发完**了，所以这里不是「阻止请求」而是「丢弃响应」。
      // 时序上的取舍：重定向复核只能在拿到响应后做（responseURL 那时才回填），
      // 无法提前。因此本闸门的作用是**不把内网内容交给模型**，而不是不发出请求。
      redirectGuard.finalUrl = String((xhr && xhr.responseURL) || '');
      if (isPrivateRedirectTarget(redirectGuard.finalUrl)) {
        const error = new Error(tActive('error.webFetch.redirectToPrivate'));
        error.fetchReason = 'redirect-private';
        throw error;
      }
      return String(xhr.responseText || '');
    },
    onParseError: error => (error && error.fetchReason === 'redirect-private'
      ? error
      : new Error(tActive('error.webFetch.parseFailed'))),
  });
  const source = String(html || '');
  const clipped = source.length > WEB_FETCH_HTML_MAX_CHARS
    ? source.slice(0, WEB_FETCH_HTML_MAX_CHARS)
    : source;
  const extracted = extractReadableText(clipped, { maxChars: WEB_FETCH_TEXT_MAX_CHARS });
  return {
    url: normalized.url,
    host: normalized.host,
    title: extracted.title,
    text: extracted.text,
    truncated: extracted.truncated,
    htmlTruncated: clipped.length !== source.length,
  };
}
