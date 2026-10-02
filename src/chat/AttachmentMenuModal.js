// 添加附件菜单：纯文本文档 / 拍照 / 图片，右上角关闭。
// 从 Alert.alert 换成自定义弹窗，原因是 Alert 原生按钮在部分机型上最多三个且
// 无法给出「不支持识图」这类禁用态与图标，拍照也需要与相册、文档并列可选。

import React, { useMemo } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

const OPTIONS = [
  {
    id: 'text',
    icon: 'document-text-outline',
    title: '纯文本文档',
    hint: 'txt / md / json 等文本内容会并入消息',
    requiresVision: false,
  },
  {
    id: 'camera',
    icon: 'camera-outline',
    title: '拍照',
    hint: '拍摄照片发送给角色',
    requiresVision: true,
  },
  {
    id: 'image',
    icon: 'image-outline',
    title: '图片',
    hint: '从相册中选择图片',
    requiresVision: true,
  },
];

export default function AttachmentMenuModal({ visible, onClose, onSelect, visionEnabled }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
          <View style={styles.attachMenuHeader}>
            <Text style={styles.modalTitle}>添加附件</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          {OPTIONS.map(option => {
            // 拍照与图片都需要识图模型：不支持时置灰并给出原因，避免走到一半才被拒。
            const locked = option.requiresVision && !visionEnabled;
            return (
              <TouchableOpacity
                key={option.id}
                style={[styles.attachMenuRow, locked && styles.attachMenuRowLocked]}
                onPress={() => {
                  if (locked) return;
                  onSelect(option.id);
                }}
                disabled={locked}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={option.title}
                accessibilityState={{ disabled: locked }}
              >
                <Ionicons
                  name={option.icon}
                  size={22}
                  color={locked ? theme.colors.textFaint : theme.colors.primarySoft}
                />
                <View style={styles.attachMenuTextWrap}>
                  <Text style={[styles.attachMenuTitle, locked && styles.attachMenuTitleLocked]}>
                    {option.title}
                  </Text>
                  <Text style={styles.attachMenuHint}>
                    {locked ? '当前来源未标记为支持识图，请先在「设置 → API」确认模型能力' : option.hint}
                  </Text>
                </View>
                {locked ? <Ionicons name="lock-closed-outline" size={15} color={theme.colors.textFaint} /> : null}
              </TouchableOpacity>
            );
          })}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
