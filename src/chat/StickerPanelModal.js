// 表情包面板弹窗。从 src/ChatScreen.js 外提；2026-09-29 增加编辑模式（多选删除 + 拖动排序）。
// 拖动：编辑态下磁贴上移动超过阈值即进入拖拽（点击仍走选中），释放时按落点重排。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, PanResponder, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

const TILE_W = 78;
const TILE_GAP = 10;
const MAX_COLUMNS = 4;
const DRAG_THRESHOLD = 6;

export default function StickerPanelModal({
  visible,
  onClose,
  stickers,
  stickerSaving,
  addStickerFromPicker,
  sendSticker,
  inputDisabled,
  onDeleteStickers,
  onReorderStickers,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const stickersRef = useRef(stickers);
  stickersRef.current = stickers;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const containerWidthRef = useRef(0);
  containerWidthRef.current = containerWidth;
  const dragIdRef = useRef(null);
  const dragOverRef = useRef(null);
  const respondersRef = useRef(new Map());

  useEffect(() => {
    if (!visible) {
      setEditing(false);
      setSelectedIds(new Set());
      setDragId(null);
      setDragOverId(null);
    }
  }, [visible]);

  const finishDrag = () => {
    const from = dragIdRef.current;
    const to = dragOverRef.current;
    dragIdRef.current = null;
    dragOverRef.current = null;
    setDragId(null);
    setDragOverId(null);
    if (!from || !to || from === to || typeof onReorderStickers !== 'function') return;
    const orderedIds = (stickersRef.current || []).map(item => item.id);
    const fromIndex = orderedIds.indexOf(from);
    const toIndex = orderedIds.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    orderedIds.splice(fromIndex, 1);
    orderedIds.splice(toIndex, 0, from);
    onReorderStickers(orderedIds).catch(() => {});
  };

  const computeOverId = (dx, dy) => {
    const list = stickersRef.current || [];
    const startIndex = list.findIndex(item => item.id === dragIdRef.current);
    if (startIndex < 0) return null;
    const width = containerWidthRef.current;
    const cols = width > 0 ? Math.max(1, Math.floor(width / (TILE_W + TILE_GAP))) : MAX_COLUMNS;
    const perRow = Math.max(1, Math.min(MAX_COLUMNS, cols));
    const colDelta = Math.round(dx / (TILE_W + TILE_GAP));
    const rowDelta = Math.round(dy / (TILE_W + TILE_GAP));
    const target = Math.max(0, Math.min(list.length - 1, startIndex + rowDelta * perRow + colDelta));
    return list[target] ? list[target].id : null;
  };

  const getResponder = id => {
    const cache = respondersRef.current;
    if (!cache.has(id)) {
      cache.set(id, PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, gesture) => (
          editingRef.current && (Math.abs(gesture.dx) > DRAG_THRESHOLD || Math.abs(gesture.dy) > DRAG_THRESHOLD)
        ),
        onPanResponderGrant: () => {
          dragIdRef.current = id;
          setDragId(id);
        },
        onPanResponderMove: (_evt, gesture) => {
          const over = computeOverId(gesture.dx, gesture.dy);
          if (over !== dragOverRef.current) {
            dragOverRef.current = over;
            setDragOverId(over);
          }
        },
        onPanResponderRelease: finishDrag,
        onPanResponderTerminate: finishDrag,
      }));
    }
    return cache.get(id);
  };

  const toggleEditing = () => {
    setEditing(current => !current);
    setSelectedIds(new Set());
    setDragId(null);
    setDragOverId(null);
    dragIdRef.current = null;
    dragOverRef.current = null;
  };

  const toggleSelected = id => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmDeleteSelected = () => {
    const ids = [...selectedRef.current];
    if (ids.length === 0 || typeof onDeleteStickers !== 'function') return;
    onDeleteStickers(ids).then(() => setSelectedIds(new Set())).catch(() => {});
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.stickerBackdrop}>
        <View style={styles.stickerSheet}>
          <View style={styles.stickerHeader}>
            <Text style={styles.stickerTitle}>{t('chat.sticker.title')}</Text>
            <View style={styles.stickerHeaderActions}>
              <TouchableOpacity
                onPress={toggleEditing}
                hitSlop={8}
                accessibilityLabel={editing ? t('chat.sticker.editDoneA11y') : t('chat.sticker.editA11y')}
                accessibilityRole="button"
              >
                <Text style={styles.stickerEditText}>{editing ? t('common.done') : t('chat.sticker.edit')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={8}
                accessibilityLabel={t('chat.sticker.closeA11y')}
                style={styles.stickerHeaderClose}
              >
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView
            style={styles.stickerScroll}
            contentContainerStyle={styles.stickerGrid}
            showsVerticalScrollIndicator={false}
            scrollEnabled={!dragId}
            onLayout={event => setContainerWidth(event.nativeEvent.layout.width)}
          >
            {!editing ? (
              <TouchableOpacity
                style={styles.stickerAddTile}
                onPress={addStickerFromPicker}
                disabled={stickerSaving}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('chat.sticker.addA11y')}
              >
                <Ionicons name="add" size={25} color={theme.colors.primarySoft} />
                <Text style={styles.stickerAddText}>{t('chat.sticker.add')}</Text>
              </TouchableOpacity>
            ) : null}
            {stickers.map(sticker => {
              const selected = selectedIds.has(sticker.id);
              const isDragging = dragId === sticker.id;
              const isDragOver = dragOverId === sticker.id && dragId !== sticker.id;
              return (
                <View
                  key={sticker.id}
                  style={[
                    styles.stickerTile,
                    selected && styles.stickerTileSelected,
                    isDragging && styles.stickerTileDragging,
                    isDragOver && styles.stickerTileDragOver,
                  ]}
                  {...(editing ? getResponder(sticker.id).panHandlers : null)}
                >
                  <TouchableOpacity
                    activeOpacity={0.8}
                    disabled={!editing && (inputDisabled || stickerSaving)}
                    onPress={() => (editing ? toggleSelected(sticker.id) : sendSticker(sticker))}
                    style={styles.stickerTileButton}
                    accessibilityRole="button"
                    accessibilityLabel={editing ? t('chat.sticker.selectA11y', { name: sticker.name }) : t('chat.sticker.sendA11y', { name: sticker.name })}
                  >
                    <Image source={{ uri: sticker.uri }} style={styles.stickerImage} resizeMode="contain" />
                    <Text style={styles.stickerName} numberOfLines={1}>{sticker.name}</Text>
                  </TouchableOpacity>
                  {editing ? (
                    <View style={[styles.stickerCheck, selected && styles.stickerCheckOn]} pointerEvents="none">
                      {selected ? (
                        <Ionicons name="checkmark" size={13} color={theme.colors.primaryContrast} />
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          {editing ? (
            <View style={styles.stickerEditBar}>
              <Text style={styles.stickerEditHint}>
                {selectedIds.size > 0 ? t('chat.sticker.selectedCount', { count: selectedIds.size }) : t('chat.sticker.editHint')}
              </Text>
              <TouchableOpacity
                style={[styles.stickerDeleteButton, selectedIds.size === 0 && styles.sendButtonDisabled]}
                onPress={confirmDeleteSelected}
                disabled={selectedIds.size === 0}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={15} color={theme.colors.text} />
                <Text style={styles.stickerDeleteText}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
