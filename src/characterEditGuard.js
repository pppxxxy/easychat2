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
