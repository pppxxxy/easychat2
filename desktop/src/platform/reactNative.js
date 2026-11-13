// react-native 别名（design.md「别名表」）：**只导出 Alert 与 Platform**。
//
// 这是一道刻意的窄门：共享层里任何模块若意外 import 了 View/Text 等 RN 组件，
// Vite 构建期会以「未导出」失败，把「偷偷复用 RN 组件」这条退化路径在源头堵死。
export { Alert } from './alert.js';
export { Platform } from './platform.js';
