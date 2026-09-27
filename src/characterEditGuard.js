// 角色页未保存编辑的跨组件信箱：角色页注册自己的未保存状态与保存入口，
// AppShell 的 tabPress 监听读取并拦截切换。默认值永远是"无未保存修改"，
// 注册方卸载或重置后回落到安全态——绝不因为读到脏值而误拦截。
let guard = { dirty: false, save: async () => false };

export function setCharacterEditGuard(next) {
  guard = next && typeof next === 'object'
    ? {
      dirty: next.dirty === true,
      save: typeof next.save === 'function' ? next.save : async () => false,
    }
    : { dirty: false, save: async () => false };
}

export function getCharacterEditGuard() {
  return guard;
}

// 从根导航状态里，把 tabPress 的 target（路由 key）解析成路由名。
// tabPress 事件给的是 key（形如 聊天-xxxx），而 navigate 只认路由名；
// 解析不出来时返回空串，调用方据此放行，绝不误拦。
export function resolveTabName(rootState, targetKey) {
  const key = String(targetKey || '');
  if (!key) return '';
  const routes = rootState && Array.isArray(rootState.routes) ? rootState.routes : [];
  const match = routes.find(route => route && route.key === key);
  return match ? String(match.name || '') : '';
}

// 角色页 Tab 切换拦截判定：返回是否需要弹确认框。
// 只有「当前在角色页 + 有未保存编辑 + 目标是别的 tab」才拦。
export function shouldConfirmTabLeave({ dirty, currentName, targetName } = {}) {
  return dirty === true
    && String(currentName || '') === '角色'
    && !!targetName
    && String(targetName) !== '角色';
}
