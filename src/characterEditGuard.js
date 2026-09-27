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

// 角色页脏判定（纯函数，便于回归）：以 seed 快照为主基准，只反映「用户改了没保存」。
// 额外兜底：表单与「当前已保存的角色内容」逐字一致时必然干净——存储层保存时会规范化
// 字段（id 去重、presets 补默认名等），回读内容可能与 save() 当时推进的 seed 基准不同，
// 只比 seed 会让用户「明明保存了还弹未保存」。与 saved 比对只用于判干净，不会把后台
// 更新误判为脏（后台更新时表单仍等于 seed 基准，两个比较都为「不等」→ 干净）。
export function isFormDirty({ formReady, currentSignature, seededSignature, savedSignature } = {}) {
  if (formReady !== true) return false;
  if (currentSignature === seededSignature) return false;
  if (savedSignature !== undefined && currentSignature === savedSignature) return false;
  return true;
}

// 角色页 Tab 切换拦截判定：返回是否需要弹确认框。
// 只有「当前在角色页 + 有未保存编辑 + 目标是别的 tab」才拦。
export function shouldConfirmTabLeave({ dirty, currentName, targetName } = {}) {
  return dirty === true
    && String(currentName || '') === '角色'
    && !!targetName
    && String(targetName) !== '角色';
}
