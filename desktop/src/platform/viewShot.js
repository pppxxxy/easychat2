// react-native-view-shot 适配：截**本应用**界面（看屏幕 v1 的桌面实现）。
//
// 手机端这个库截的是自己 App 的 View 树（零权限）；桌面的等价物是主进程的
// webContents.capturePage()（IPC 见 electron/ipc/capture.js）。
//
// 契约对齐共享层实际用到的两个成员（src/screenWatch/capture.js）：
//   · captureScreen({ format:'jpg', quality, result:'tmpfile' }) → 临时文件 uri；
//   · releaseCapture(uri) → 释放原生侧临时资源（桌面无临时资源，空操作）。
//
// 三处诚实差异：
//   1. 产出 PNG 而非 JPG：capturePage 不支持 jpg 编码，后缀随内容写 .png，
//      否则按后缀判 MIME 的消费者会读出错图；
//   2. quality 被忽略：png 无损，没有质量参数；
//   3. 没有「临时文件」概念：主进程直接写进 documents/screen-watch/，
//      因此 releaseCapture 不删任何东西（删了会把要用的截图删掉）。
import { getBridge } from './bridge.js';

export const CaptureResult = Object.freeze({ tmpfile: 'tmpfile', base64: 'base64', dataUri: 'dataUri' });

export async function captureScreen(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.result && opts.result !== CaptureResult.tmpfile) {
    // 共享层只用 tmpfile；其余形态明确拒绝比静默返回错类型安全。
    throw new Error(`captureScreen: result "${opts.result}" is not supported on desktop`);
  }
  const bridge = getBridge();
  if (!bridge || !bridge.capture || typeof bridge.capture.appScreen !== 'function') {
    throw new Error('captureScreen: capture bridge is not available');
  }
  const result = await bridge.capture.appScreen();
  if (!result || result.ok !== true || !result.uri) {
    throw new Error(`captureScreen failed: ${(result && result.reason) || 'unknown'}`);
  }
  return String(result.uri);
}

export function releaseCapture(uri) {
  // 桌面没有原生临时资源：截图已是持久文件，由 screen-watch 的滚动清扫回收。
  // 刻意不删除——共享层以为这是「临时文件」，删了会让当次评论读到空路径。
  // 参数按共享层的位置契约保留（调用方传 uri），这里显式忽略。
  void uri;
  return undefined;
}

export default { captureScreen, releaseCapture, CaptureResult };