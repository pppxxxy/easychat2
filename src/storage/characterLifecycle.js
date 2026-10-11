// 角色生命周期钩子：把「删除角色时要清掉什么」从硬编码清单改成注册机制。
//
// 背景：`saveCharacterState` 原先手写一串清理调用（向量索引 → 消息 → 日记 → 日记设置
// → 世界地图）。每加一个「按角色存数据」的新域，都必须记得回来改这个函数——而
// `@easychat2_affinity`（好感度）就是这样漏掉的：删角色后数据永久残留。
// 更糟的是级联还分成两套：moments 的清理写在 CharacterScreen 的删除流程里，
// 门面这套根本不知道它存在。
//
// 机制：每个域在自己的模块里注册清理钩子（谁的数据谁负责），保存编排
// （storage/characterState.js）只负责跑钩子。
// 新增域 = 在自己模块里调一次 onCharacterDeleted()，不再需要改任何既有文件。
//
// 约定：
// - 钩子只接收「被删除的角色 id 数组」，必须自己容错（单个域失败不阻断其它域）；
// - 钩子按注册顺序串行执行；runCharacterCleanup 逐个 try/catch，失败只记**诊断**
//   不影响主流程（删角色是用户动作，不能因为某个域清理失败就让整个删除失败）；
// - DEFAULT_CHARACTER 由保存编排在调用前过滤，钩子不必再判。

import { recordDiagnostic } from './diagnostics.js';

const cleanupHooks = [];

/**
 * 注册「角色被删除」时的清理钩子。
 * @param {string} name 域名称（用于诊断日志与去重提示）
 * @param {(characterIds: string[]) => Promise<void>|void} handler 清理函数
 */
export function onCharacterDeleted(name, handler) {
  if (typeof handler !== 'function') return;
  cleanupHooks.push({ name: String(name || 'anonymous'), handler });
}

/** 跑全部清理钩子。任何单个钩子抛错都只记录，不阻断其余钩子与主流程。 */
export async function runCharacterCleanup(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  if (ids.length === 0) return;
  for (const { name, handler } of cleanupHooks) {
    try {
      await handler(ids);
    } catch (error) {
      // 这里以前只有 `if (__DEV__) console.warn(...)`：生产构建里 __DEV__ 为假，整段被摇掉，
      // 于是「某个域的数据没清掉」**完全不可观测**（io.js 对存储损坏是会 recordDiagnostic 的，
      // 同一条纪律）。清理失败不阻断主流程，但必须留下可查的记录。
      recordDiagnostic('storage', error, `角色删除清理失败：${name}`);
      // __DEV__ 是 Metro 全局，纯 Node 环境不存在：不判 typeof 会在 catch 里抛
      // ReferenceError，把「单个域失败」升级成「整个清理链失败」——正是这里要避免的。
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`[characterCleanup] ${name} 清理失败`, error);
      }
    }
  }
}

// 测试用：清空注册表（避免测试间互相污染）。
export function __resetCharacterCleanupHooks() {
  cleanupHooks.length = 0;
}

// 测试用：当前已注册的域名单。
export function __listCharacterCleanupHooks() {
  return cleanupHooks.map(item => item.name);
}
