// 路由名常量：唯一权威来源。
//
// 路由名是**内部标识符**（不是展示文案），保持中文值不动——它被 App.js 的
// Tab.Screen 注册与各处的 navigation.navigate() 引用，改值会造成连锁改动风险；
// 只翻译可见的 tabBarLabel（见 App.js 的 t('app.tab.*')）。
//
// 集中定义的目的：避免字符串字面量散落在多个文件里，一旦拼写不一致
// （如 '聊天' 与 '聊 天'），navigation.navigate 会静默失败、只在运行时表现为
// 「点了没反应」，很难排查。所有调用点一律 import 本模块。
//
// 新增路由时：先在这里加常量，再在 App.js 注册 Tab.Screen，最后才是调用点。

export const ROUTES = {
  chat: '聊天',
  memory: '记忆',
  character: '角色',
  extension: '扩展',
  settings: '设置',
};

// 便于 `navigate(ROUTE_NAMES.chat)` 的简写别名（与 ROUTES 同值，语义更贴近用法）。
export const ROUTE_NAMES = ROUTES;

// 校验用：所有路由名的集合（供测试断言 Tab.Screen 注册与本表一致）。
export const ROUTE_NAME_LIST = Object.values(ROUTES);
