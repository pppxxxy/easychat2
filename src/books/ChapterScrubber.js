// 章节目录的竖向定位条：形态抄聊天页的 ScrollScrubber（右侧窄轨 + 可拖动滑块），
// 但场景更简单——目标只有「第几章」，不需要消息预览卡片。
//
// 两个约定：
// - 打开目录时滑块停在当前章的位置（currentIndex 驱动，拖动中不打断手指）；
// - 拖动过程中在轨道左侧实时显示「第 N / M 章 · 标题」，松手才真正跳转
//   （拖动中每帧都滚动目录会非常卡）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

const THUMB_HEIGHT = 40;
const THUMB_WIDTH = 10;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export default function ChapterScrubber({ chapters = [], currentIndex = 0, onSeek }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const list = Array.isArray(chapters) ? chapters : [];
  const count = list.length;
  const [trackHeight, setTrackHeight] = useState(0);
  const [index, setIndex] = useState(currentIndex);
  const [dragging, setDragging] = useState(false);
  const translateY = useRef(new Animated.Value(0)).current;
  // 手势里要读的当前值放 ref：PanResponder 只创建一次，读 state 会拿到创建时的旧值。
  const trackHeightRef = useRef(0);
  const indexRef = useRef(currentIndex);
  const onSeekRef = useRef(onSeek);
  const startYRef = useRef(0);
  const draggingRef = useRef(false);
  onSeekRef.current = onSeek;

  const usable = () => Math.max(1, trackHeightRef.current - THUMB_HEIGHT);

  const indexFromY = useCallback(y => {
    if (count <= 1) return 0;
    const ratio = clamp01((y - THUMB_HEIGHT / 2) / usable());
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  }, [count]);

  const yFromIndex = useCallback(value => {
    if (count <= 1) return 0;
    return (Math.min(count - 1, Math.max(0, value)) / (count - 1)) * usable();
  }, [count]);

  // 当前章或轨道尺寸变化时把滑块摆到对应位置；拖动中不打断手指。
  useEffect(() => {
    if (draggingRef.current) return;
    const next = Math.min(count - 1, Math.max(0, Math.floor(Number(currentIndex)) || 0));
    indexRef.current = next;
    setIndex(next);
    translateY.setValue(yFromIndex(next));
  }, [count, currentIndex, trackHeight, translateY, yFromIndex]);

  const applyY = useCallback(y => {
    const next = indexFromY(y);
    indexRef.current = next;
    setIndex(next);
    translateY.setValue(yFromIndex(next));
    return next;
  }, [indexFromY, translateY, yFromIndex]);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => trackHeightRef.current > THUMB_HEIGHT && count > 1,
    onMoveShouldSetPanResponder: () => trackHeightRef.current > THUMB_HEIGHT && count > 1,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      draggingRef.current = true;
      setDragging(true);
      // 按下位置用 locationY（相对轨道视图），比 gestureState 更可靠。
      startYRef.current = event.nativeEvent.locationY;
      applyY(event.nativeEvent.locationY);
    },
    onPanResponderMove: (_event, gesture) => {
      // 移动中用累计位移叠加起点：手指越过滑块后 locationY 会变成相对滑块的坐标。
      applyY(startYRef.current + gesture.dy);
    },
    onPanResponderRelease: () => {
      draggingRef.current = false;
      setDragging(false);
      if (onSeekRef.current) onSeekRef.current(indexRef.current);
    },
    onPanResponderTerminate: () => {
      draggingRef.current = false;
      setDragging(false);
    },
  })).current;

  if (count <= 1) return null;

  const chapter = list[Math.min(count - 1, Math.max(0, index))] || null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {dragging && chapter ? (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeIndex}>
            {t('books.reader.chapter.position', { index: index + 1, total: count })}
          </Text>
          <Text style={styles.badgeTitle} numberOfLines={2}>{chapter.title}</Text>
        </View>
      ) : null}
      <View
        style={styles.track}
        pointerEvents="box-only"
        onLayout={event => {
          const height = event.nativeEvent.layout.height;
          trackHeightRef.current = height;
          setTrackHeight(height);
        }}
        accessibilityRole="adjustable"
        accessibilityLabel={t('books.reader.chapter.scrubber.a11y')}
        accessibilityValue={{ min: 1, max: count, now: index + 1 }}
        {...panResponder.panHandlers}
      >
        <View style={styles.rail} pointerEvents="none" />
        <Animated.View style={[styles.thumb, { transform: [{ translateY }] }]} pointerEvents="none" />
      </View>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 4,
    top: 12,
    bottom: 12,
    width: 40,
    alignItems: 'center',
  },
  track: {
    width: 30,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  rail: {
    position: 'absolute',
    top: THUMB_HEIGHT / 2,
    bottom: THUMB_HEIGHT / 2,
    width: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.surfaceBorder,
  },
  thumb: {
    position: 'absolute',
    top: 0,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_WIDTH / 2,
    backgroundColor: theme.colors.primary,
    borderWidth: 1,
    borderColor: theme.colors.primarySoft,
  },
  badge: {
    position: 'absolute',
    right: 38,
    top: '36%',
    maxWidth: 210,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  badgeIndex: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700' },
  badgeTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginTop: 3,
  },
});
