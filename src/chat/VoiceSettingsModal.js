import React, { useMemo } from 'react';
import { Modal, Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function VoiceSettingsModal({ visible, onClose, voiceMode, onToggleVoiceMode, onOpenTranscription }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>语音设置</Text>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="volume-high-outline" size={17} color={theme.colors.primaryMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.chatSettingsText}>全语音模式</Text>
                <Text style={styles.chatSettingsHint}>开启后当前角色只显示语音气泡，不显示回复正文</Text>
              </View>
            </View>
            <Switch
              value={voiceMode}
              onValueChange={onToggleVoiceMode}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => {
              onClose();
              onOpenTranscription();
            }}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="mic-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.chatSettingsText}>语音转文字设置</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
