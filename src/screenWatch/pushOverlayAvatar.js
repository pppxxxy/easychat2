// FEAT-AC3：把悬浮球头像推到原生的**编排层**（JS 侧收口）。
//
// 为什么单独一个文件（不复用 overlayConfig.js 的 writeOverlayConfigSnapshot）：
// 那条路径**要求存在 API 配置**（buildOverlayConfigSnapshot 拿不到 config 就返回 null）。
// 而头像与 API 配置毫无关系——用户没配模型时也该能换头像。所以走独立通道，
// 只在最后一步复用同一个原生桥（overlay.js 的 setOverlayAvatar）。
//
// 三处调用点（任务书 P0-3）：
//   1) 开启悬浮窗前的快照构建（ScreenWatchScreen 的 startOverlay 流程）；
//   2) 设置页改模式/换自定义图后立即推（AvatarCard）；
//   3) 悬浮窗关闭→重开天然走 1。

import { getOverlayAvatarSettings } from '../storage/settings/overlayAvatar.js';
import { resolveOverlayAvatarSource, normalizeCharacterAvatarUri } from './overlayAvatarSource.js';
import { setOverlayAvatar } from './overlay.js';
import { writeOverlayConfigSnapshot } from './overlayConfig.js';
// 文件系统基路径走本域的封装点（分层规则：新文件不得直接 import expo-file-system）。
import { screenWatchDocumentDirectory } from './capture.js';

/**
 * 计算并推送当前该用的头像。
 *
 * @param {object} args
 * @param {object|null} [args.character] 当前角色（character 模式取它的 avatarUri）
 * @returns {Promise<boolean>} 是否成功推给原生（无原生桥时为 false，不抛）
 */
export async function pushOverlayAvatar({ character = null } = {}) {
  let settings;
  try {
    settings = await getOverlayAvatarSettings();
  } catch (error) {
    // 设置读不出来（损坏）：**不猜**，按默认档（App 图标）推。
    // 抛错给用户没意义——这里是启动/挂载路径，弹错会打断开悬浮窗。
    settings = { mode: 'default', customUri: '' };
  }
  const characterAvatarUri = normalizeCharacterAvatarUri(
    character && character.avatarUri,
    screenWatchDocumentDirectory()
  );
  const payload = resolveOverlayAvatarSource({
    mode: settings.mode,
    customUri: settings.customUri,
    characterAvatarUri,
  });
  return setOverlayAvatar(payload);
}

/**
 * FEAT-AC3：把「悬浮窗需要的 JS 侧状态」一次推全（配置快照 + 头像）。
 *
 * 为什么合并成一个入口（而不是让 App.js 分别调两次）：
 *   1) 两者**时机完全相同**（启动 / 回前台 / 切角色），分开调必然漂移；
 *   2) App.js 是装配根，已经贴着 800 行棘轮——把编排放在域内是仓库既有纪律
 *     （拆文件而不是抬上限，AC1/AC2 都这么处理的）。
 * 两条推送各自 catch：一条失败不该拖累另一条（头像与模型配置互不依赖）。
 */
export async function pushOverlayJsState({ character = null } = {}) {
  const snapshot = writeOverlayConfigSnapshot({ character }).catch(() => false);
  const avatar = pushOverlayAvatar({ character }).catch(() => false);
  await Promise.all([snapshot, avatar]);
}
