// 群聊成员数量上限——**唯一来源**（零依赖叶子，Node 与 RN 都能直接引用）。
//
// 此前这个数字散落在手机侧：src/character/useGroupCreation.js 的 `>= 8`、
// GroupCreateModal 的提示文案、i18n 的「选择成员（已选 N / 2-8）」。
// 桌面群聊要复用同一条约束，因此抽成常量：改上限只改这里。
export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 8;