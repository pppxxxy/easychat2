import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from './theme/ThemeContext';
import { indexFromRatio } from './scrollScrubberMath';

export { getScrollRange, indexFromRatio } from './scrollScrubberMath';

const PREVIEW_THRESHOLD = 30;
const THUMB_HEIGHT = 44;
const THUMB_WIDTH = 10;

export default function ScrollScrubber({
  visible,
  onClose,
  messageCount,
  previews,
  onSeek,
  onToStart,
  onToEnd,
}) {
  const [ratio, setRatio] = useState(0);
  const [dragging, setDragging] = useState(false);
  const translateY = useRef(new Animated.Value(0)).current;
  const previewIndexRef = useRef(-1);
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const trackHeightRef = useRef(0);
  const messageCountRef = useRef(messageCount);
  const onSeekRef = useRef(onSeek);
   const gestureStartRatioRef = useRef(0);
   const currentRatioRef = useRef(0);
   messageCountRef.current = messageCount;
  onSeekRef.current = onSeek;

  const usableHeight = () => Math.max(1, trackHeightRef.current - THUMB_HEIGHT);

  useEffect(() => {
    if (!visible) return;
    setDragging(false);
    setRatio(0);
     previewIndexRef.current = -1;
     currentRatioRef.current = 0;
     translateY.setValue(0);
  }, [visible]);

  const ratioFromY = y => {
    const usable = usableHeight();
    return Math.min(1, Math.max(0, (y - THUMB_HEIGHT / 2) / usable));
  };

   const applyRatio = next => {
     const usable = usableHeight();
     currentRatioRef.current = next;
     translateY.setValue(next * usable);
    const count = messageCountRef.current;
    const index = indexFromRatio(next, count);
    if (index !== previewIndexRef.current) {
      previewIndexRef.current = index;
      setRatio(next);
    }
    return next;
  };

  const jumpToStart = () => {
    applyRatio(0);
    onToStart?.();
  };

  const jumpToEnd = () => {
    applyRatio(1);
    onToEnd?.();
  };

  const commitRatio = next => {
    const count = messageCountRef.current;
    if (count > 0) onSeekRef.current?.(indexFromRatio(next, count));
  };

  const adjustRatio = direction => {
    const count = messageCountRef.current;
    if (count <= 1) return;
    const step = direction > 0 ? 1 / (count - 1) : -1 / (count - 1);
    const next = Math.min(1, Math.max(0, currentRatioRef.current + step));
    applyRatio(next);
    commitRatio(next);
  };

  const onAccessibilityAction = event => {
    const action = event && event.nativeEvent && event.nativeEvent.actionName;
    if (action === 'increment') adjustRatio(1);
    if (action === 'decrement') adjustRatio(-1);
  };

   const panResponder = useRef(
     PanResponder.create({
        onStartShouldSetPanResponder: () => trackHeightRef.current > THUMB_HEIGHT,
        onStartShouldSetPanResponderCapture: () => trackHeightRef.current > THUMB_HEIGHT,
        onMoveShouldSetPanResponder: () => trackHeightRef.current > THUMB_HEIGHT,
        onMoveShouldSetPanResponderCapture: () => trackHeightRef.current > THUMB_HEIGHT,
       onPanResponderTerminationRequest: () => false,
         onPanResponderGrant: event => {
           setDragging(true);
        // 按下位置的 locationY 相对轨道视图，是可靠的；用它作为拖拽起点。
        const start = ratioFromY(event.nativeEvent.locationY);
        gestureStartRatioRef.current = start;
        applyRatio(start);
      },
        onPanResponderMove: (_event, gestureState) => {
          // 移动过程中不能用 locationY：手指越过滑块后它变成相对滑块的坐标，
         // 会导致滑块来回跳到顶部。改用累计位移 dy 叠加起始比例。
         const next = Math.min(1, Math.max(0, gestureStartRatioRef.current + gestureState.dy / usableHeight()));
         applyRatio(next);
       },
        onPanResponderRelease: (_event, gestureState) => {
          const next = Math.min(1, Math.max(0, gestureStartRatioRef.current + gestureState.dy / usableHeight()));
          applyRatio(next);
           setDragging(false);
           commitRatio(next);
         },
         onPanResponderTerminate: () => {
           setDragging(false);
           commitRatio(currentRatioRef.current);
         },
    })
  ).current;

  const count = Number.isFinite(messageCount) ? messageCount : 0;
  const previewIndex = indexFromRatio(ratio, count);
  const showPreview = dragging
    && count > PREVIEW_THRESHOLD
    && Array.isArray(previews)
    && previews[previewIndex];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.dismiss}
          activeOpacity={1}
          onPress={onClose}
          accessibilityLabel="关闭定位"
        />
        <View style={styles.panel}>
          <TouchableOpacity
            style={[styles.jumpButton, count === 0 && styles.disabled]}
            onPress={jumpToStart}
            disabled={count === 0}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.jumpText}>回到开头</Text>
          </TouchableOpacity>

          <View
            style={styles.track}
             onLayout={event => {
               trackHeightRef.current = event.nativeEvent.layout.height;
             }}
              accessibilityRole="adjustable"
              accessibilityLabel="内容定位滑块"
              accessibilityValue={{
                min: 0,
                max: Math.max(count - 1, 0),
                now: previewIndex,
                text: count > 0 ? `${previewIndex + 1} / ${count}` : '无消息',
              }}
              accessibilityActions={[
                { name: 'increment', label: '下一条' },
                { name: 'decrement', label: '上一条' },
              ]}
              onAccessibilityAction={onAccessibilityAction}
             {...panResponder.panHandlers}
          >
            <Animated.View
              style={[styles.thumb, { transform: [{ translateY }] }]}
              pointerEvents="none"
            />
          </View>

          <TouchableOpacity
            style={[styles.jumpButton, count === 0 && styles.disabled]}
            onPress={jumpToEnd}
            disabled={count === 0}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-down" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.jumpText}>回到最新</Text>
          </TouchableOpacity>
        </View>

        {showPreview ? (
          <View style={styles.previewCard} pointerEvents="none">
            <Text style={styles.previewLabel} numberOfLines={1}>
              {previews[previewIndex].label}
            </Text>
            <Text style={styles.previewSpeaker} numberOfLines={1}>
              {previews[previewIndex].speaker}
            </Text>
            <Text style={styles.previewText} numberOfLines={3}>
              {previews[previewIndex].text}
            </Text>
            <Text style={styles.previewPosition}>
              {`${previewIndex + 1} / ${count}`}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: theme.colors.overlay },
  dismiss: { ...StyleSheet.absoluteFillObject },
   panel: {
     position: 'absolute',
     zIndex: 20,
     elevation: 20,
    right: 18,
    top: 90,
    bottom: 120,
    width: 74,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    paddingVertical: 12,
  },
  jumpButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  jumpText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(10), fontWeight: '700', marginTop: 2 },
   track: {
     zIndex: 30,
     elevation: 30,
     flex: 1,
    width: 34,
    marginVertical: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
    backgroundColor: 'transparent',
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
  disabled: { opacity: 0.4 },
  previewCard: {
    position: 'absolute',
    right: 100,
    top: '40%',
    maxWidth: 220,
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
  },
  previewLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  previewSpeaker: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginTop: 4 },
  previewText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17), marginTop: 4 },
  previewPosition: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6 },
});
