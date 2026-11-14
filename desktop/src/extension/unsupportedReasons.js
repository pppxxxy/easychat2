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
  // 只剩「悬浮窗」这一子能力不可移植：在其他应用之上绘制自己的界面 + 跨应用截屏，
  // Android 靠 SYSTEM_ALERT_WINDOW + MediaProjection。桌面没有等价物。
  // 注意「看屏幕」页面本身**已可用**（截本应用画面，见 platform/viewShot.js），
  // 所以这个 id 不再出现在扩展页的不可用清单里——只作为该页的一段能力说明。
  screenOverlay: 'desktop.unsupported.screenOverlay',
  // 只剩「插件运行时」：从外部加载第三方 JS 并在原生侧注入界面。
  // 内置插件（联网搜索）的配置**已可用**（纯 HTTP，见 extension/screens/PluginScreen.jsx），
  // 所以这个 id 不再出现在扩展页的不可用清单里——只作为插件页的一段能力说明。
  pluginRuntime: 'desktop.unsupported.pluginRuntime',
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