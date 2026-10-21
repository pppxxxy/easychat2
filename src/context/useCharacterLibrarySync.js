import { useEffect } from 'react';

import { subscribeCharacterLibraryChange } from './characterLibrarySync.js';

// 把「角色库在别处被改过 → 重读一遍」接进组件生命周期。
//
// 为什么单独成一个 hook 而不是直接写在 AppContext 里：AppContext 已经贴着 800 行
// 的棘轮上限（scripts/guard-structure.mjs），而这段带解释的接线本身要占十来行。
// 摊在外面既不撑爆组件，也让「订阅/退订」这段容易写错的逻辑有独立落点。
//
// 为什么订阅必须放在 useEffect：不在 effect 里注册会在每次渲染时叠加一个监听器，
// 且永远不释放（notify 一次就触发 N 次重读）。effect 返回 subscribe 给的退订函数，
// React 在依赖变化/卸载时自动解绑。
//
// 为什么吞掉 refresh 的拒绝：这次刷新只影响界面显示，没有数据风险；而它的上游
// 是「MCP 已经写盘成功」的路径，刷新失败绝不能冒泡回去把成功变成报错。
export function useCharacterLibrarySync(refresh) {
  useEffect(() => {
    if (typeof refresh !== 'function') return undefined;
    return subscribeCharacterLibraryChange(() => {
      refresh().catch(() => {});
    });
  }, [refresh]);
}
