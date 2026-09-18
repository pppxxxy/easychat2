import React, { useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

const PREVIEW_THRESHOLD = 30;
const THUMB_SIZE = 26;

export function indexFromRatio(ratio, messageCount) {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  return Math.round(clamped * (messageCount - 1));
}

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
  const [trackHeight, setTrackHeight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const trackHeightRef = useRef(0);
  const ratioRef = useRef(0);
  const messageCountRef = useRef(messageCount);
  const onSeekRef = useRef(onSeek);
  messageCountRef.current = messageCount;
  onSeekRef.current = onSeek;

  const applyY = y => {
    const usable = Math.max(1, trackHeightRef.current - THUMB_SIZE);
    const next = Math.min(1, Math.max(0, (y - THUMB_SIZE / 2) / usable));
    ratioRef.current = next;
    setRatio(next);
    return next;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: event => {
        setDragging(true);
        applyY(event.nativeEvent.locationY);
      },
      onPanResponderMove: event => {
        applyY(event.nativeEvent.locationY);
      },
      onPanResponderRelease: event => {
        const next = applyY(event.nativeEvent.locationY);
        setDragging(false);
        const count = messageCountRef.current;
        if (count > 0) {
          onSeekRef.current?.(indexFromRatio(next, count));
        }
      },
      onPanResponderTerminate: () => setDragging(false),
    })
  ).current;

  const count = Number.isFinite(messageCount) ? messageCount : 0;
  const previewIndex = indexFromRatio(ratio, count);
  const showPreview = dragging
    && count > PREVIEW_THRESHOLD
    && Array.isArray(previews)
    && previews[previewIndex];
  const thumbTop = ratio * Math.max(0, trackHeight - THUMB_SIZE);

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
            onPress={onToStart}
            disabled={count === 0}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={16} color="#c8c4ff" />
            <Text style={styles.jumpText}>回到开头</Text>
          </TouchableOpacity>

          <View
            style={styles.track}
            onLayout={event => {
              const height = event.nativeEvent.layout.height;
              trackHeightRef.current = height;
              setTrackHeight(height);
            }}
            {...panResponder.panHandlers}
          >
            <View style={[styles.thumb, { top: thumbTop }]} />
          </View>

          <TouchableOpacity
            style={[styles.jumpButton, count === 0 && styles.disabled]}
            onPress={onToEnd}
            disabled={count === 0}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-down" size={16} color="#c8c4ff" />
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

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  dismiss: { ...StyleSheet.absoluteFillObject },
  panel: {
    position: 'absolute',
    right: 18,
    top: 90,
    bottom: 120,
    width: 74,
    alignItems: 'center',
    backgroundColor: '#20203a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#35354f',
    paddingVertical: 12,
  },
  jumpButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  jumpText: { color: '#c8c4ff', fontSize: 10, fontWeight: '700', marginTop: 2 },
  track: {
    flex: 1,
    width: 34,
    marginVertical: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#6c63ff',
    borderWidth: 2,
    borderColor: '#b9b3ff',
  },
  disabled: { opacity: 0.4 },
  previewCard: {
    position: 'absolute',
    right: 100,
    top: '40%',
    maxWidth: 220,
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#4a4a68',
    padding: 12,
  },
  previewLabel: { color: '#8a8aa3', fontSize: 11 },
  previewSpeaker: { color: '#ffffff', fontSize: 13, fontWeight: '700', marginTop: 4 },
  previewText: { color: '#c9c9e0', fontSize: 12, lineHeight: 17, marginTop: 4 },
  previewPosition: { color: '#6f6f8d', fontSize: 11, marginTop: 6 },
});
