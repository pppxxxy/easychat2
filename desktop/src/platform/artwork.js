// 桌面端内置角色素材：主进程在启动时把打包资源复制到 documents/avatars/（见
// electron/main.js 的 ensureDefaultArtwork），渲染层这边只做「确认存在 + 登记保护」。
//
// 为什么不在渲染层复制：渲染进程只能通过 fs 桥访问 documents/cache，读不到应用
// 安装目录里的打包资源；复制放在主进程既符合边界，也避免把 500KB 图片编进渲染包。
// markMediaWrite 与 Android 端同源（src/storage/mediaProtection.js）：先登记再引用，
// 堵住「落盘与登记之间被回收器误删」的窗口。
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { setArtworkLoader } from '../../../src/character/artworkLoader.js';

const AVATAR_FILE = 'default-assistant-avatar.jpg';
const BG_FILE = 'default-assistant-bg.jpg';

export function createDesktopArtworkLoader(bridge) {
  return async () => {
    const dir = `${bridge.app.paths.documentDirectory}avatars/`;
    const avatarUri = `${dir}${AVATAR_FILE}`;
    const bgUri = `${dir}${BG_FILE}`;
    const [avatarInfo, bgInfo] = await Promise.all([
      bridge.fs.stat(avatarUri).catch(() => null),
      bridge.fs.stat(bgUri).catch(() => null),
    ]);
    const avatarOk = !!(avatarInfo && avatarInfo.exists);
    const bgOk = !!(bgInfo && bgInfo.exists);
    if (avatarOk) markMediaWrite(avatarUri);
    if (bgOk) markMediaWrite(bgUri);
    return {
      avatarUri: avatarOk ? avatarUri : '',
      bgUri: bgOk ? bgUri : '',
    };
  };
}

export function installDesktopArtworkLoader(bridge) {
  setArtworkLoader(createDesktopArtworkLoader(bridge));
}
