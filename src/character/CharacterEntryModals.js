// 角色详情页的面板内弹层：导入进度遮罩 + 世界书条目编辑 + 正则脚本编辑。
// 纯展示组件：state 与 handler 全部由 CharacterDetailScreen 注入（styles/theme/t 一并透传）。
import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { RegexEntryEditor, WorldEntryEditor } from './editors.js';

export default function CharacterEntryModals({
  styles,
  theme,
  t,
  importStatus,
  importStatusTitle,
  importStatusHint,
  editingWorldEntry,
  editingWorldIndex,
  updateWorldEntry,
  removeWorldEntry,
  setEditingWorldId,
  editingRegexEntry,
  editingRegexIndex,
  updateRegexScript,
  removeRegexScript,
  setEditingRegexId,
}) {
  return (
    <>
      <Modal
        visible={!!importStatus}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.importOverlayBackdrop}>
          <View style={styles.importOverlayCard}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.importOverlayTitle}>{importStatusTitle}</Text>
            <Text style={styles.importOverlayHint}>{importStatusHint}</Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!editingWorldEntry}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingWorldId(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('character.detail.world.editTitle')}</Text>
              <TouchableOpacity
                onPress={() => setEditingWorldId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>{t('common.done')}</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              {editingWorldEntry ? (
                <WorldEntryEditor
                  entry={editingWorldEntry}
                  index={editingWorldIndex}
                  onChange={patch => updateWorldEntry(editingWorldEntry.id, patch)}
                  onRemove={() => {
                    removeWorldEntry(editingWorldEntry.id);
                    setEditingWorldId(null);
                  }}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={!!editingRegexEntry}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingRegexId(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('character.detail.regex.editTitle')}</Text>
              <TouchableOpacity
                onPress={() => setEditingRegexId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>{t('common.done')}</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              {editingRegexEntry ? (
                <RegexEntryEditor
                  script={editingRegexEntry}
                  index={editingRegexIndex}
                  onChange={patch => updateRegexScript(editingRegexEntry.id, patch)}
                  onRemove={() => {
                    removeRegexScript(editingRegexEntry.id);
                    setEditingRegexId(null);
                  }}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
