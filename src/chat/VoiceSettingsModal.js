import React, { useMemo } from 'react';
import { Modal, Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function VoiceSettingsModal({ visible, onClose, voiceMode, onToggleVoiceMode, onOpenTranscription, autoBroadcast, onToggleBroadcast }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('chat.voiceSettings.title')}</Text>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="volume-high-outline" size={17} color={theme.colors.primaryMuted} />
              <View style={{ flex: 1 }}>

                <Text style={styles.chatSettingsText}>{t('chat.voice.broadcast.label')}</Text>
                <Text style={styles.chatSettingsHint}>{t('chat.voice.broadcast.hint')}</Text>
              </View>
            </View>
            <Switch
              value={autoBroadcast === true}
              onValueChange={onToggleBroadcast}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="chatbox-ellipses-outline" size={17} color={theme.colors.primaryMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.chatSettingsText}>{t('chat.voiceSettings.fullMode')}</Text>
                <Text style={styles.chatSettingsHint}>{t('chat.voiceSettings.fullModeHint')}</Text>

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
              <Text style={styles.chatSettingsText}>{t('chat.voiceSettings.transcription')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
