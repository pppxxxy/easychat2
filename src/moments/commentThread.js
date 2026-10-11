// 动态评论的线程化：把扁平的评论列表按 replyToId 组成「顶层评论 + 一层回复」。
//
// 设计约束：
// - 纯函数、零依赖，便于单测；
// - 评论默认是对动态本身的回应（replyToId 为空 = 顶层）；只有当一条评论明确回复
//   某条已有评论时才挂到那条下面（用户 2026-10-11 的需求：重点是回应发动态的人，
//   对角色评论的评论才做小标挂靠）；
// - 渲染只需要一层缩进，所以这里直接输出「渲染序列」而不是嵌套树——RN 里递归嵌套
//   组件既不好写也不好测。

// 模型输出里标注「这条是回复某人的评论」的前缀：回复<名字>：/ @<名字> / ＠<名字>。
// 名字用「非空白、非标点」的连续字符，避免把整句话吞掉。
const REPLY_PREFIX_RE = /^\s*(?:回复|@|＠)\s*([^\s：:，,。.!！?？]{1,20})\s*[：:，,]?\s*/;

// 解析一条模型输出：若开头是「回复<名字>：」，且 <名字> 能对上已有评论的作者，
// 则把它转成对那条评论的回复。名字对不上（模型编了个人名）时只把前缀剥掉，仍按
// 顶层评论处理——宁可少一层挂靠，也不要显示一个指向不存在评论的标记。
export function parseCommentReplyTarget(raw, comments) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { text: '', replyToId: '' };
  const match = text.match(REPLY_PREFIX_RE);
  if (!match) return { text, replyToId: '' };
  const name = String(match[1] || '').trim();
  const rest = text.slice(match[0].length).trim();
  const list = Array.isArray(comments) ? comments : [];
  // 同名取最后一条（最近的），避免把新回复挂到很久以前的同名评论上。
  let target = null;
  for (const comment of list) {
    if (comment && String(comment.name || '').trim() === name) target = comment;
  }
  if (!target || !rest) return { text: rest || text, replyToId: '' };
  return { text: rest, replyToId: String(target.id || '') };
}

// 可解析的父评论 id：必须存在、不能指向自己。悬空引用（父评论被删了）一律当顶层，
// 否则那条评论会从列表里「消失」。
function resolveParentId(comment, byId) {
  const id = String((comment && comment.id) || '');
  const parentId = String((comment && comment.replyToId) || '');
  if (!parentId || parentId === id) return '';
  return byId.has(parentId) ? parentId : '';
}

// 顺着 replyToId 上溯，找到这条评论所属的顶层祖先 id。
// 遇到环（老数据/人工写入可能造成 a↔b 互指）就把自己当顶层，否则两条都会从列表里
// 消失——宁可不缩进，也不能把评论藏起来。
function findRootId(comment, byId) {
  const id = String((comment && comment.id) || '');
  const seen = new Set([id]);
  let cursorId = id;
  for (;;) {
    const parentId = resolveParentId(byId.get(cursorId), byId);
    if (!parentId) return cursorId;
    if (seen.has(parentId)) return id;
    seen.add(parentId);
    cursorId = parentId;
  }
}

// 扁平评论列表 → 渲染序列 [{ comment, depth, parentName }]。
// depth=0 顶层；depth=1 表示挂在某条顶层评论下（parentName 是它回复的那条的作者名）。
// 只保留一层缩进：回复的回复也挂到同一个顶层祖先下，但标记里写它直接回复的人。
export function flattenCommentThread(comments) {
  const list = (Array.isArray(comments) ? comments : []).filter(item => item && item.id);
  const byId = new Map(list.map(item => [String(item.id), item]));
  const childrenOf = new Map();
  const rootIdOf = new Map();

  for (const comment of list) {
    const id = String(comment.id);
    const rootId = findRootId(comment, byId);
    rootIdOf.set(id, rootId);
    if (rootId === id) continue;
    const parentName = String((byId.get(resolveParentId(comment, byId)) || {}).name || '');
    if (!childrenOf.has(rootId)) childrenOf.set(rootId, []);
    childrenOf.get(rootId).push({ comment, parentName });
  }

  const out = [];
  for (const comment of list) {
    const id = String(comment.id);
    if (rootIdOf.get(id) !== id) continue;
    out.push({ comment, depth: 0, parentName: '' });
    for (const child of childrenOf.get(id) || []) {
      out.push({ comment: child.comment, depth: 1, parentName: child.parentName });
    }
  }
  return out;
}

// 某条评论下的直接回复数（UI 上给「N 条回复」之类的小标用）。
export function countDirectReplies(comments, commentId) {
  const id = String(commentId || '');
  if (!id) return 0;
  const list = Array.isArray(comments) ? comments : [];
  const byId = new Map(list.filter(item => item && item.id).map(item => [String(item.id), item]));
  return list.filter(item => item && resolveParentId(item, byId) === id).length;
}
