// 版本号比较与「要不要弹公告」的纯逻辑。零依赖，Node 直测。
//
// 为什么单独成模块：本地版本取自 expo-constants、远端版本取自 GitHub release 的 tag，
// 两边形态不同（'v2.10.1' / '2.10.1' / 'release-2.10.1' / 空 tag），比较与「不再提示」
// 的判定全是纯计算，抽出来才能被行为测试钉住，而不是埋在界面里靠真机验。

// 从 tag / name 里取出版本号数字段：容忍 'v' 前缀与任意非数字前缀（如 release-2.10.1）。
// 返回 [major, minor, patch]（个数不定，只保留前导数字段）；取不出返回 null。
export function parseVersion(text) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)*)/);
  if (!match) return null;
  const parts = match[1].split('.').map(part => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
  return parts.length > 0 ? parts : null;
}

// 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等（或缺信息）返回 0。
// 缺字段按 0 补齐（'2.10' 与 '2.10.0' 视为相等）。任一侧解析不出 ⇒ 0（不当作新版）。
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const x = left[index] || 0;
    const y = right[index] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 远端版本是否比本地新。解析不出（tag 为空/格式怪）一律「不是新版」——
// 公告只该在能确定有新版本时打扰用户。
export function isNewerVersion(remote, local) {
  if (!parseVersion(remote) || !parseVersion(local)) return false;
  return compareVersions(remote, local) > 0;
}

// 「不再提示」的本地标记：一个键存版本号（只记最新被忽略的那个版本）。
export const DISMISSED_RELEASE_KEY = '@easychat2_announcement_dismissed';

// 该不该为这个 release 弹公告。
// release 为空 / 版本不比本地新 / 已被用户「不再提示此版本」⇒ 不弹。
// 用户忽略 v2.10.0 后出了 v2.10.1，因为记的是版本号，新版本会照常再弹。
export function shouldAnnounce(release, localVersion, dismissedVersion = '') {
  if (!release || typeof release !== 'object') return false;
  const remote = String(release.version || '');
  if (!isNewerVersion(remote, localVersion)) return false;
  // 只比「版本号」而不是 tag 字面量：tag 形态（v 前缀/前缀词）不该影响判定。
  if (dismissedVersion && compareVersions(dismissedVersion, remote) === 0) return false;
  return true;
}
