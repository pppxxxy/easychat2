// 原生重负载资源互斥：录音、TTS、本地推理等同一时间只允许一个持有者。
//
// 为什么在 src/utils/：它是纯工具（无 IO、无 RN、无业务状态），三个业务调用点
// （network/modelProvider.js、chat/useChatModelThinking.js、localModel/panel/usePanelModels.js）
// 都在子目录里，根目录只该留入口文件（见 scripts/guard-structure.mjs 的根文件棘轮）。
//
// 调用约定：拿不到就自己处理「忙」（回退在线 API / 弹提示），所以只有 tryAcquireResource
// 这一个入口——曾经还有一个会抛 RESOURCE_BUSY 的 withResource，但没有任何调用点需要
// 「抛出去」的语义（四处都是优雅降级），它是死导出，已删除。
//
// 释放函数幂等：重复调用只生效一次，且只有当自己仍是当前持有者时才清空——
// 迟到的释放不会把后来者的锁误清掉。

let owner = '';

export function tryAcquireResource(name) {
  const requested = String(name || '').trim();
  if (!requested || owner) return null;
  owner = requested;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (owner === requested) owner = '';
  };
}

export function resetResourceMutexForTests() {
  owner = '';
}
