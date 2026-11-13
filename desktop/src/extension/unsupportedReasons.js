// 桌面不可用入口的原因（纯数据 + 纯函数，Node 直测）。
//
// 为什么单独成模块而不是散在界面里：这份清单同时被
//   · 扩展页（渲染入口与展开原因）；
//   · 结构守卫测试（钉住「这些是真的不可移植，不是懒得做」）；
// 两处消费。判定标准很窄：**依赖 Android/Expo 系统能力**，数据层不存在或必须走
// 原生才能成立。凡是数据层与判定已在本仓 src/ 下、只差 DOM 界面的，都不属于这里
// ——那些属于「还没做」，不该被写成「做不了」。
import { tActive } from '../../../src/i18n/index.js';

// key → i18n 词条名（原因文案）。词条在 locales/*/desktop.js 里。
export const UNAVAILABLE_REASONS = Object.freeze({
  // 需要持续截屏 + 悬浮窗服务；桌面没有等价的系统级截屏授权模型。
  screenWatch: 'desktop.unsupported.screenWatch',
  // 依赖 Android 侧的 WebView 插件运行时与动态加载的界面注入点。
  plugins: 'desktop.unsupported.plugins',
  // 依赖 Headless JS（App 被杀后由原生唤起执行），桌面进程退出后没有等价载体。
  scheduledTasks: 'desktop.unsupported.scheduled',
  // 依赖 llama.cpp 原生绑定与 mmap 权重的移动端集成。
  localModels: 'desktop.unsupported.localModels',
  // 工作区工具需要沙箱化的 shell / 文件系统写权限模型，桌面尚未建立该授权面。
  workspaceTools: 'desktop.unsupported.workspace',
});

export const UNAVAILABLE_IDS = Object.freeze(Object.keys(UNAVAILABLE_REASONS));

// 取某个入口的不可用原因（已完成 i18n）。未登记即返回空串（调用方据此按可用处理）。
export function unsupportedReason(id) {
  const key = UNAVAILABLE_REASONS[String(id || '')];
  if (!key) return '';
  return tActive(key);
}