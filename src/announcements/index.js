// 公告的薄 IO 层：拉取 GitHub 最新 release、落本地缓存、读写「不再提示」标记。
// 网络与存储都在这里，判定逻辑全在 version.js / release.js（纯函数，Node 直测）。
//
// 数据源：GET https://api.github.com/repos/pppxxxy/easychat2/releases/latest
//   - 公共端点，**无需 token**；
//   - 只发这一个请求，不带任何 Key、不带任何用户数据上行（SECURITY.md 语义）；
//   - 失败一律静默返回缓存（公告不可用绝不能打扰用户，更不能弹错误）。
import AsyncStorage from '@react-native-async-storage/async-storage';

import { request, GITHUB_API_BASE } from '../workspace/github/restApi.js';
import { readJsonStatus, setJsonRaw } from '../storage/io.js';
import { DISMISSED_RELEASE_KEY, shouldAnnounce } from './version.js';
import { normalizeRelease } from './release.js';

export const RELEASE_REPO_OWNER = 'pppxxxy';
export const RELEASE_REPO_NAME = 'easychat2';
export const ANNOUNCEMENT_CACHE_KEY = '@easychat2_announcement_cache';
// 公告拉取超时：短一点。它只是「顺手看看有没有新版」，不该在启动时拖着用户等。
export const ANNOUNCEMENT_TIMEOUT_MS = 8000;
export const LATEST_RELEASE_URL =
  `${GITHUB_API_BASE}/repos/${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}/releases/latest`;

// 拉最新 release 并归一。任何失败（断网/限流/超时/结构异常）都抛出，由调用方决定
// 回落缓存——本函数不吞错，免得「拿不到」与「拿到了空的」被混成同一件事。
export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = ANNOUNCEMENT_TIMEOUT_MS } = {}) {
  // retryDelays 传空数组：启动路径上不需要退避重试，一次不成就算了（下次启动再说）。
  const { data } = await request(fetchImpl, LATEST_RELEASE_URL, { timeoutMs, retryDelays: [] });
  const release = normalizeRelease(data);
  if (!release.tag) throw new Error('release payload has no tag_name');
  return release;
}

export async function readCachedRelease() {
  const stored = await readJsonStatus(ANNOUNCEMENT_CACHE_KEY);
  if (stored.status !== 'ok' || !stored.value || typeof stored.value !== 'object') return null;
  const release = normalizeRelease(stored.value);
  return release.tag ? release : null;
}

// 缓存结构带 fetchedAt：断网启动时用旧缓存，也便于诊断「内容是不是陈的」。
export async function writeCachedRelease(release, now = Date.now()) {
  if (!release || !release.tag) return null;
  const payload = { ...release, fetchedAt: now };
  await setJsonRaw(ANNOUNCEMENT_CACHE_KEY, payload);
  return payload;
}

// 拉取并落缓存；失败时返回缓存（可能为 null）。**不抛错**——启动路径专用。
export async function loadReleaseOrCache({ fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const release = await fetchLatestRelease({ fetchImpl });
    await writeCachedRelease(release, now).catch(() => {});
    return { release, fromCache: false };
  } catch (error) {
    const cached = await readCachedRelease().catch(() => null);
    return { release: cached, fromCache: true };
  }
}

export async function getDismissedVersion() {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_RELEASE_KEY);
    return raw ? String(JSON.parse(raw) || '') : '';
  } catch (error) {
    return '';
  }
}

export async function setDismissedVersion(version) {
  const value = String(version || '').trim();
  if (!value) return false;
  await AsyncStorage.setItem(DISMISSED_RELEASE_KEY, JSON.stringify(value));
  return true;
}

// 组装「要不要弹、弹什么」：拉取（或回落缓存）→ 与本地版本比对 → 看用户是否已忽略。
// 返回 { release, shouldShow }；任何一环失败都返回 shouldShow:false，不抛错。
export async function resolveAnnouncement({
  fetchImpl = fetch,
  localVersion = '',
  now = Date.now(),
} = {}) {
  const { release, fromCache } = await loadReleaseOrCache({ fetchImpl, now });
  if (!release) return { release: null, shouldShow: false, fromCache };
  const dismissed = await getDismissedVersion().catch(() => '');
  return {
    release,
    fromCache,
    shouldShow: shouldAnnounce(release, localVersion, dismissed),
  };
}
