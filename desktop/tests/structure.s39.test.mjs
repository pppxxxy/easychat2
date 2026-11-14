// 桌面外壳结构守卫（S39）：复核剩余 7 项「平台差异」+ 7 项「不适用」的结果。
//
// 复核方法与前一轮相同：每一项都去读手机实现，再问「桌面真的没有等价物吗」。
// 结论是 6 项经不起细读——它们不是平台限制，而是没做：
//   1. 安全状态未知拦截层：桌面把「读不出来」静默当成「没上锁」（锁形同虚设）。
//   2. 附件「拍照 / 拍摄视频」：桌面有摄像头也能 getUserMedia，只是没接。
//   3. 阅读器翻页：CSS 多列就能分页，不依赖 RN 文本测量。
//   4. 悬浮窗：alwaysOnTop + transparent 就是置顶自绘窗口；整屏截图用 desktopCapturer。
//   5. 悬浮球头像三档：同一份共享存储，缺的只是 UI。
//   6. （深链）不需要：桌面悬浮窗是独立窗口，没有「回跳主窗」这个需求。
// 剩下的 4 项「不适用」是真平台限制（生物识别 / 无障碍服务 / Android 系统权限）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

test('安全未知拦截层：状态感知，不再静默放行', () => {
  const gate = read('src', 'settings', 'RoleLockGate.jsx');
  assert.ok(gate.includes('getSecuritySettings'), '应读带 status 的设置');
  assert.ok(gate.includes('SECURITY_STATUS'), '应区分 ok/missing/unknown');
  assert.ok(gate.includes('unknownAcknowledged'), '未知态应要求显式确认');
  // 判据看 import：不再引入 isCharacterLocked（它在损坏时返回 false，无法区分未知）。
  assert.ok(!/import[^;]*isCharacterLocked/.test(gate), '不应再 import isCharacterLocked');
  // 三个动作：重试 / 显式继续 / 提示说明。
  for (const key of ['error.security.stateUnknownRetry', 'error.security.stateUnknownContinue',
    'error.security.stateUnknownTitle']) {
    assert.ok(gate.includes(key), `未知态缺动作：${key}`);
  }
  // 手机侧确实有同一套判定（不是桌面自己发明的语义）。
  const mobile = readRoot('src', 'security', 'SecurityGate.js');
  assert.ok(mobile.includes('securityUnknown'), '手机侧应有同源判定');
});

test('附件：拍照 / 拍视频用 Web 原生能力实现', () => {
  const cam = read('src', 'attachments', 'CameraDialog.jsx');
  assert.ok(cam.includes('getUserMedia'), '应打开摄像头');
  assert.ok(cam.includes('toDataURL'), '拍照应经 canvas 取帧');
  assert.ok(cam.includes('MediaRecorder'), '录像应经 MediaRecorder');
  assert.ok(cam.includes("chat-videos"), '录像应落进聊天视频目录');
  assert.ok(cam.includes('markMediaWrite'), '落盘后应登记媒体保护');
  // 附件 hook 要把「已落盘文件」接进既有校验链路，而不是另开一条。
  const hook = read('src', 'attachments', 'useDesktopAttachments.js');
  assert.ok(hook.includes('addCaptured'), '应暴露 addCaptured');
  assert.ok(/addImageFromUri|addVideoFromUri/.test(hook), '应复用既有追加路径');
  const composer = read('src', 'provider', 'ChatComposer.jsx');
  assert.ok(composer.includes('CameraDialog'), '输入区应挂载相机对话框');
  // 主进程必须放行摄像头权限，否则 getUserMedia 一律 NotAllowedError。
  const main = read('electron', 'main.js');
  assert.ok(main.includes('setPermissionRequestHandler'), '应有权限处理');
  assert.ok(/allowed\.has\('media'\)|allowed = new Set\(\['media'/.test(main), '应放行 media 权限');
});

test('阅读器翻页模式：CSS 多列分页 + 点击/键盘翻页', () => {
  const reader = read('src', 'extension', 'screens', 'BookReader.jsx');
  assert.ok(reader.includes('pageMode'), '应有滚动/翻页双模式');
  assert.ok(/columnWidth/.test(reader), '翻页应使用 CSS 多列');
  assert.ok(reader.includes('turnPage'), '应能翻页');
  assert.ok(/ArrowLeft|PageUp/.test(reader), '应支持键盘翻页');
  assert.ok(reader.includes('desktop.reader.page'), '应显示页码');
  // 进度按页记（与手机按页记同口径）。
  assert.ok(/pageIndex \/ pageCount/.test(reader), '翻页模式进度应按页算');
});

test('悬浮窗：置顶窗口 + 整屏截图 + 三档头像', () => {
  const ipc = read('electron', 'ipc', 'overlay.js');
  assert.ok(ipc.includes('alwaysOnTop'), '应立即置顶');
  assert.ok(ipc.includes('transparent'), '应透明');
  assert.ok(ipc.includes('skipTaskbar'), '不应占任务栏');
  assert.ok(ipc.includes("hash: 'overlay'"), '应加载悬浮窗入口');
  assert.ok(ipc.includes('overlay:start') && ipc.includes('overlay:stop'), '应有开关通道');

  const capture = read('electron', 'ipc', 'capture.js');
  assert.ok(capture.includes('desktopCapturer'), '整屏截图应用 desktopCapturer');
  assert.ok(capture.includes("types: ['screen']"), '应截整屏');
  assert.ok(capture.includes('capture:screen'), '应有整屏截图通道');

  const overlay = read('src', 'overlay', 'OverlayApp.jsx');
  assert.ok(overlay.includes('useScreenWatchComments'), '应复用共享评论链路');
  assert.ok(overlay.includes('capture.screen'), '点头像应截整屏');
  assert.ok(overlay.includes('overlayAvatar'), '头像应走共享三档设置');

  const card = read('src', 'extension', 'screens', 'OverlayAvatarCard.jsx');
  assert.ok(card.includes('OVERLAY_AVATAR_MODES'), '应复用共享三档常量');
  assert.ok(card.includes('markMediaWrite'), '自定义头像应登记媒体保护');

  // 能力位与不可用清单要同步（否则界面自相矛盾）。
  const caps = read('src', 'platform', 'capabilities.js');
  assert.ok(/screenOverlay: true/.test(caps), '能力位应为 true');
  const reasons = read('src', 'extension', 'unsupportedReasons.js');
  assert.ok(!reasons.includes('screenOverlay'), '不应再列为不可用');
});

test('剩余 4 项不适用仍成立（真平台限制）', () => {
  // 生物识别：手机的应用锁开关在设备无生物识别时**本身就被禁用**——桌面等价于那台设备，
  // 因此「应用锁」不是桌面缺口，而是同一套平台自适应行为。
  const section = readRoot('src', 'settings', 'sections', 'SecuritySection.js');
  assert.ok(/biometricUnavailable/.test(section), '手机应禁用无生物识别时的应用锁');
  assert.ok(/disabled=\{[^}]*biometricUnavailable/.test(section), '开关应被禁用');
  // 无障碍服务 / 精确闹钟 / 电池优化：Android 专有，桌面无对应 API。
  const reasons = read('src', 'extension', 'unsupportedReasons.js');
  for (const id of ['pluginRuntime', 'scheduledTasks', 'localModels', 'workspaceTools']) {
    assert.ok(reasons.includes(`${id}: '`), `仍应保留不可用项：${id}`);
  }
});
