// 添加附件菜单：纯文本文档 / 拍照 / 图片 / 拍摄视频 / 上传视频，右上角关闭。
// 从 Alert.alert 换成自定义弹窗，原因是 Alert 原生按钮在部分机型上最多三个且
// 无法给出「不支持识图」这类禁用态与图标，拍照也需要与相册、文档并列可选。
//
// 门控分两级：拍照/图片要识图能力（requiresVision），视频入口要「看视频」能力
//（requiresVideo，且发送侧会再按协议复检——video_url 只在 OpenAI 兼容协议下可用）。

import React, { useMemo } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTranslation } from '../i18n/I18nContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

// 选项的文案键，实际文本由 t() 在渲染时取（语言切换后无需重建模块级常量）。
const OPTION_KEYS = [
  { id: 'text', icon: 'document-text-outline', titleKey: 'chat.attach.text.title', hintKey: 'chat.attach.text.hint', requiresVision: false },
  { id: 'camera', icon: 'camera-outline', titleKey: 'chat.attach.camera.title', hintKey: 'chat.attach.camera.hint', requiresVision: true },
  { id: 'image', icon: 'image-outline', titleKey: 'chat.attach.image.title', hintKey: 'chat.attach.image.hint', requiresVision: true },
  { id: 'video-camera', icon: 'videocam-outline', titleKey: 'chat.attach.videoCamera.title', hintKey: 'chat.attach.videoCamera.hint', requiresVideo: true },
  { id: 'video', icon: 'film-outline', titleKey: 'chat.attach.video.title', hintKey: 'chat.attach.video.hint', requiresVideo: true },
];

export default function AttachmentMenuModal({ visible, onClose, onSelect, visionEnabled, videoEnabled }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
          <View style={styles.attachMenuHeader}>
            <Text style={styles.modalTitle}>{t('chat.attach.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('chat.attach.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          {OPTION_KEYS.map(option => {
            // 拍照/图片要识图；视频要「看视频」能力。不支持时置灰并给出原因，
            // 避免走到一半才被拒。
            const locked = (option.requiresVision && !visionEnabled)
              || (option.requiresVideo && !videoEnabled);
            const title = t(option.titleKey);
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
                accessibilityLabel={title}
                accessibilityState={{ disabled: locked }}
              >
                <Ionicons
                  name={option.icon}
                  size={22}
                  color={locked ? theme.colors.textFaint : theme.colors.primarySoft}
                />
                <View style={styles.attachMenuTextWrap}>
                  <Text style={[styles.attachMenuTitle, locked && styles.attachMenuTitleLocked]}>
                    {title}
                  </Text>
                  <Text style={styles.attachMenuHint}>
                    {locked
                      ? t(option.requiresVideo ? 'chat.attach.videoRequired' : 'chat.attach.visionRequired')
                      : t(option.hintKey)}
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
