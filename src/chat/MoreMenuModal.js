// 聊天页「更多」菜单弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。
// items 由调用方构造（依赖 ChatScreen 状态与回调），本组件只负责渲染。

import React, { useMemo } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function MoreMenuModal({ visible, onClose, items }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.moreBackdrop}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={styles.moreSheet}>
          {items.map(item => (
            <TouchableOpacity
              key={item.key}
              style={[styles.moreRow, item.disabled && styles.actionDisabled]}
              disabled={item.disabled}
              onPress={() => {
                onClose();
                if (typeof item.onPress === 'function') item.onPress();
              }}
              activeOpacity={0.8}
            >
              <Ionicons
                name={item.icon}
                size={16}
                color={item.active ? theme.colors.primary : theme.colors.primaryMuted}
              />
              <Text style={[styles.moreRowText, item.active && styles.moreRowTextActive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
