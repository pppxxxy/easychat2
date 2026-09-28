// 表情包面板弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';
import { createChatStyles } from './chatStyles';

export default function StickerPanelModal({
  visible,
  onClose,
  stickers,
  stickerSaving,
  addStickerFromPicker,
  sendSticker,
  inputDisabled,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

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
            <Text style={styles.stickerTitle}>表情包</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={8}
              accessibilityLabel="关闭表情包"
            >
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.stickerScroll}
            contentContainerStyle={styles.stickerGrid}
            showsVerticalScrollIndicator={false}
          >
            <TouchableOpacity
              style={styles.stickerAddTile}
              onPress={addStickerFromPicker}
              disabled={stickerSaving}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="添加表情包"
            >
              <Ionicons name="add" size={25} color={theme.colors.primarySoft} />
              <Text style={styles.stickerAddText}>添加</Text>
            </TouchableOpacity>
            {stickers.map(sticker => (
              <TouchableOpacity
                key={sticker.id}
                style={styles.stickerTile}
                onPress={() => sendSticker(sticker)}
                disabled={inputDisabled || stickerSaving}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`发送表情包 ${sticker.name}`}
              >
                <Image source={{ uri: sticker.uri }} style={styles.stickerImage} resizeMode="contain" />
                <Text style={styles.stickerName} numberOfLines={1}>{sticker.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
