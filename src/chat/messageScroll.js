// 虚拟化消息列表的定位算术（纯函数，可单测）。
//
// 背景：MessageList 的滚动容器从 ScrollView 换成 FlatList 后，原来「每条消息 onLayout 把
// layout.y 累积进 messageOffsetsRef」的定位方式不再成立——虚拟化窗口外的项根本没有
// onLayout，缓存里必然缺值。定位因此改走 FlatList 的 scrollToIndex：index 是**当前窗口内**
// 的下标（窗口外的消息由 ChatScreen 扩窗后重试）。本模块承载其中可测的算术部分，
// 组件里只留接线。
//
// 语义依据（node_modules/@react-native/virtualized-lists/Lists/VirtualizedList.js）：
// - scrollToIndex 在 index<0 / itemCount<1 / index>=itemCount 时直接 invariant 抛错（:165-180）；
// - 没有 getItemLayout 且 index > highestMeasuredCellIndex 时不猜位置，而是回调
//   onScrollToIndexFailed({ index, averageItemLength, highestMeasuredFrameIndex })（:181-197）。

// scrollToIndex 的 viewOffset：与旧实现 `scrollTo({ y: offset - 80 })` 语义对齐——
// 目标消息顶部落在视口顶部下方 80px（靠近列表顶部时由框架钳到 0）。
export const MESSAGE_SCROLL_VIEW_OFFSET = 80;
// 兜底估算用的保守平均项高：框架还没测出任何项高时（averageItemLength 为 0）用它。
export const MESSAGE_SCROLL_FALLBACK_ITEM_LENGTH = 120;
// 「先滚到估算落点、再重试 scrollToIndex」的间隔（毫秒）。
export const MESSAGE_SCROLL_RETRY_DELAY_MS = 120;
// 同一次定位允许的兜底重试次数上限。必须有限：估算偏差大时落点可能不变，
// 无上限就是「失败 → 滚到同一处 → 再失败」的滚动风暴。
export const MESSAGE_SCROLL_MAX_RETRY = 4;

// 按 id 找消息在**当前窗口**里的下标；找不到返回 -1（调用方据此扩窗重试）。
export function messageIndexById(messages, id) {
  if (!Array.isArray(messages) || id === null || id === undefined) return -1;
  const target = String(id);
  if (!target) return -1;
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    if (!item || item.id === null || item.id === undefined) continue;
    if (String(item.id) === target) return index;
  }
  return -1;
}

// scrollToIndex 的入参合法性：越界会命中 VirtualizedList 的 invariant 抛错（闪退），
// 所以调用前一律先过这一关（数据在异步等待期间可能变短）。
export function canScrollToIndex(index, itemCount) {
  const count = Number(itemCount);
  if (!Number.isInteger(index) || index < 0) return false;
  if (!Number.isFinite(count) || count < 1) return false;
  return index < count;
}

// 兜底落点：按框架给的平均项高把目标估成 y 偏移（再减掉 viewOffset 保持落点语义一致）。
// 估算不会失败，用它把目标推进渲染窗口，之后重试 scrollToIndex 才有机会成功。
export function scrollFallbackOffset({ index, averageItemLength, viewOffset = MESSAGE_SCROLL_VIEW_OFFSET } = {}) {
  const safeIndex = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0;
  const measured = Number(averageItemLength);
  const step = Number.isFinite(measured) && measured > 0 ? measured : MESSAGE_SCROLL_FALLBACK_ITEM_LENGTH;
  const offset = safeIndex * step - (Number(viewOffset) || 0);
  return Math.max(0, offset);
}

// 重试预算：次数用完就放弃（定位不到比无限滚动好）。
export function shouldRetryScrollToIndex(retryCount) {
  const used = Number(retryCount);
  if (!Number.isFinite(used) || used < 0) return false;
  return used < MESSAGE_SCROLL_MAX_RETRY;
}
