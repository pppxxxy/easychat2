// Markdown 书籍的连续滚动渲染：按「块」（blocks.js 的 12000 字上限）用 FlatList
// 虚拟化渲染，避免整本 Markdown 一次性交给 markdown-it 卡死渲染线程。
// 可见块回调驱动父级进度保存与「让TA聊聊这段」的摘录；目录跳转经 scrollToIndex，
// 变高列表在未测量到目标块时用 onScrollToIndexFailed 先滚近似偏移再重试。

import React, { useCallback, useRef } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { clampMarkdownText } from '../markdownGuard.js';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10, minimumViewTime: 120 };

function topVisible(viewableItems) {
  let best = null;
  (Array.isArray(viewableItems) ? viewableItems : []).forEach(entry => {
    if (!entry || typeof entry.index !== 'number') return;
    if (!best || entry.index < best.index) best = entry;
  });
  return best;
}

export default function BookMarkdownList({
  blocks,
  markdownStyles,
  initialIndex = 0,
  onBlockChange,
  listRef,
  contentContainerStyle,
}) {
  const onBlockChangeRef = useRef(onBlockChange);
  onBlockChangeRef.current = onBlockChange;

  // 初始定位（initialScrollIndex / 目录 scrollToIndex）会经过中间块，若直接上报会把
  // 进度误写成第 0 块。只有用户真正拖动过列表后才接受可见块变化；目录跳转由父级显式
  // 设置块号，不依赖这里。
  const userScrolledRef = useRef(false);
  const handleScrollBeginDrag = useCallback(() => {
    userScrolledRef.current = true;
  }, []);

  // onViewableItemsChanged / viewabilityConfig 在挂载后不得更换，故用 ref 固化。
  const handleViewableRef = useRef(({ viewableItems }) => {
    if (!userScrolledRef.current) return;
    const top = topVisible(viewableItems);
    if (top) onBlockChangeRef.current?.(top.index);
  });
  const viewabilityConfigRef = useRef(VIEWABILITY_CONFIG);

  const renderItem = useCallback(({ item }) => {
    const { text } = clampMarkdownText(item.text);
    return (
      <View style={styles.block}>
        <Markdown style={markdownStyles}>{text}</Markdown>
      </View>
    );
  }, [markdownStyles]);

  const handleScrollToIndexFailed = useCallback(info => {
    const ref = listRef && listRef.current;
    if (!ref) return;
    const offset = Math.max(0, Math.round((info.averageItemLength || 0) * (info.index || 0)));
    ref.scrollToOffset({ offset, animated: false });
    // 首屏未渲染到目标块时，等一帧渲染完再精确重试（FlatList 官方建议做法）。
    setTimeout(() => {
      try {
        ref.scrollToIndex({ index: info.index, animated: false });
      } catch (error) {}
    }, 120);
  }, [listRef]);

  return (
    <FlatList
      ref={listRef}
      data={blocks}
      keyExtractor={block => String(block.index)}
      renderItem={renderItem}
      initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
      onScrollToIndexFailed={handleScrollToIndexFailed}
      onScrollBeginDrag={handleScrollBeginDrag}
      onViewableItemsChanged={handleViewableRef.current}
      viewabilityConfig={viewabilityConfigRef.current}
      contentContainerStyle={contentContainerStyle}
      initialNumToRender={3}
      maxToRenderPerBatch={3}
      windowSize={5}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 2 },
});
