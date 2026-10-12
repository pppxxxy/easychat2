// web_fetch 的**本地域名白名单**（用户点「永久允许」才会写入，可撤销）。
//
// 键 `@easychat2_web_fetch_whitelist`，形状 `{ domains: [...] }`（对象包一层，
// 将来加版本/元数据字段不用动根结构；形状照 settings/workspacePermissions.js）。
//
// 为什么单独一个存储域：授权必须**显式**（只有用户点「永久允许」才写，绝不自动）
// 且**可撤销**（remove / clear），所以需要一份跨重启记住的名单。规则本体的匹配
// 口径不在本文件另写一份 —— 见下。
//
// ⚠️ 匹配口径**必须**与 plugins/webFetch.js 的 isDomainAllowed 完全一致，因此这里
// **直接 import 它**，而不是在存储层复制一份比较逻辑：两份口径一定会分叉，而分叉的
// 表现正是「授权了但下次仍问」或「没授权却放行」——前者烦人、后者是安全洞。
// 同层先例：workspacePermissions.js:15 同样 import agent/permissions.js 的归一化。
//（反向依赖不存在：plugins/webFetch.js 不 import storage，guard:structure 的循环
//  检查可证；这也是本 import 方向可行的原因。）
//
// ⚠️ 本模块与 isDomainAllowed 有**一处刻意反转**：空名单在这里等于
// **什么都不放行**（isWebFetchDomainWhitelisted 直接返回 false），而 isDomainAllowed
// 对空名单的语义是「放行全部」。理由：本地白名单为空 = 用户还没授权过任何域名，
// 未授权域名**必须走弹窗**（产品决策：默认要求白名单），绝不能因为「名单是空的」
// 被当成「没有任何限制」而静默放行。
//
// ⚠️ 第三层内网防线：normalizeWhitelistDomain 对**本机/内网主机一律返回空串**
// （不写盘）。授权层不得成为绕过 plugins/webFetch.js 的 isPrivateHostInfo 的通道：
// 即便用户在弹窗上点了「永久允许」，内网域名也不会被记住，更不会被放行
// （第一层是 normalizeFetchUrl 在授权之前就拒了，第二层是 runWebFetch 的授权闸门
//  再判一次，这里是第三层）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { isDomainAllowed, isPrivateHost, parseAllowedDomains } from '../../plugins/webFetch.js';
import { tActive } from '../../i18n/index.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../io.js';

export const WEB_FETCH_WHITELIST_KEY = '@easychat2_web_fetch_whitelist';

const whitelistMutation = createMutationQueue();

// 纯函数：把一条用户输入归一成可存储的域名；不接受就返回空串。
// 归一化直接复用 parseAllowedDomains（与 allowedDomains 同一条口径：
// 小写、去协议、去路径/查询），所以「插件配置里写的」与「白名单里存的」
// 比较方式必然相同。
export function normalizeWhitelistDomain(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  // 通配符**不支持**：isDomainAllowed 是「精确相等 或 `.域名` 后缀」比较，
  // `*.example.com` 会被当成字面域名、**永远不命中**。存进去等于骗用户
  //（以为授权了，下次照样问），所以这里直接拒绝，让调用方看得见。
  if (text.includes('*')) return '';
  const [domain] = parseAllowedDomains(text);
  if (!domain) return '';
  // 内网/本机不记盘（见文件头「第三层内网防线」）。
  if (isPrivateHost(domain)) return '';
  return domain;
}

// 纯函数：域名是否在**给定名单**里放行。名单为空 ⇒ false（刻意与 isDomainAllowed
// 的空名单语义相反，理由见文件头）。
export function isWebFetchHostWhitelisted(host, domains) {
  const list = parseAllowedDomains(domains);
  if (list.length === 0) return false;
  return isDomainAllowed(host, list);
}

// 读白名单并**保留读取状态**。读路径对外行为不变（损坏时给空名单 = 照常弹窗问人），
// status 只交给写路径判定「这次能不能写回」。
// **形状校验收进读函数**：readJsonStatus 的 `ok` 只保证 JSON.parse 成功，值可能是
// null / 原语 / 数组。照 workspacePermissions.js:36-51（含那次「第四态」修复）：
// 「ok 但形状坏」与 corrupt 同归一类，否则读-改-写整表覆盖会把用户记住的授权冲掉。
async function readStore() {
  const stored = await readJsonStatus(WEB_FETCH_WHITELIST_KEY);
  if (
    stored.status === 'ok'
    && stored.value !== null
    && typeof stored.value === 'object'
    && !Array.isArray(stored.value)
  ) {
    const raw = Array.isArray(stored.value.domains) ? stored.value.domains : [];
    const domains = [];
    raw.forEach(item => {
      const value = normalizeWhitelistDomain(item);
      if (value && !domains.includes(value)) domains.push(value);
    });
    return { status: 'ok', domains };
  }
  if (stored.status === 'missing') return { status: 'missing', domains: [] };
  await backupCorruptValue(WEB_FETCH_WHITELIST_KEY);
  return { status: 'corrupt', domains: [] };
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。理由同 workspacePermissions.js:63-68：
// 本域的写入全是读-改-写整表覆盖，读失败时「当前名单」是空的，于是
//   - add 写回「只剩刚点的那一个域名」；
//   - remove 写回「除了要删的那个，其余全没」；
// 用户点一次「永久允许」就把此前记住的域名全清掉。损坏时拒绝写，原始字节已被备份。
function requireDomainsForMutation(current) {
  if (current.status === 'corrupt') {
    throw new Error(tActive('error.storage.webFetchWhitelistReadFailed'));
  }
  return current.domains;
}

async function writeStore(domains) {
  const list = [];
  domains.forEach(item => {
    const value = normalizeWhitelistDomain(item);
    if (value && !list.includes(value)) list.push(value);
  });
  await AsyncStorage.setItem(WEB_FETCH_WHITELIST_KEY, JSON.stringify({ domains: list }));
}

export async function getWebFetchWhitelist() {
  return (await readStore()).domains;
}

// 宿主注入用的**读侧**入口（runWebFetch 的 options.isDomainWhitelisted）：
// 读失败按「没有白名单」处理 —— **宁问不猜**：存储异常不能被当成「已授权」，
// 否则一次读失败就变成静默放行。
export async function isWebFetchDomainWhitelisted(host) {
  let domains = [];
  try {
    domains = await getWebFetchWhitelist();
  } catch (error) {
    return false;
  }
  return isWebFetchHostWhitelisted(host, domains);
}

// 「永久允许」的落盘入口：**只有用户显式点击才会被调用**（调用点在
// plugins/webFetch.js 的授权闸门里，且只在 decision === 'always' 分支）。
// 归一化不接受（内网 / 通配符 / 空）时返回 null 且不写盘。
export function addWebFetchWhitelistDomain(domain) {
  const value = normalizeWhitelistDomain(domain);
  if (!value) return Promise.resolve(null);
  return whitelistMutation.enqueue(async () => {
    const current = requireDomainsForMutation(await readStore());
    if (!current.includes(value)) await writeStore([...current, value]);
    return value;
  });
}

// 撤销单个域名（授权必须可撤销 —— 点错一次不能成了没法回头的坑）。
export function removeWebFetchWhitelistDomain(domain) {
  const value = normalizeWhitelistDomain(domain);
  if (!value) return Promise.resolve(false);
  return whitelistMutation.enqueue(async () => {
    const current = requireDomainsForMutation(await readStore());
    const next = current.filter(item => item !== value);
    if (next.length === current.length) return false;
    await writeStore(next);
    return true;
  });
}

// 清空白名单（撤销入口，供设置页「清空已授权域名」使用）。
export function clearWebFetchWhitelist() {
  return whitelistMutation.enqueue(async () => {
    requireDomainsForMutation(await readStore());
    await writeStore([]);
    return true;
  });
}

// 设置页展示用：条数 + 损坏标记（不谎报「0 条」）。
// 供后续 UI 消费（本轮无 UI 改动，见交付报告「白名单可撤销性现状」）。
export async function getWebFetchWhitelistCount() {
  const current = await readStore();
  return { count: current.domains.length, corrupt: current.status === 'corrupt' };
}
