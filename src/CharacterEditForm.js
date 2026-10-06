import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Ionicons from '@expo/vector-icons/Ionicons';

import { markMediaWrite } from './storage/mediaProtection.js';
import { buildSystemPrompt } from './character/cardParser.js';
import { useApp } from './context/AppContext.js';
import { CharacterFormFields } from './character/CharacterFormFields.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

function emptyDraft(character) {
  return {
    name: String(character?.name || ''),
    systemPrompt: String(character?.systemPrompt || ''),
    description: String(character?.description || ''),
    personality: String(character?.personality || ''),
    scenario: String(character?.scenario || ''),
    firstMes: String(character?.firstMes || ''),
    alternateGreetings: Array.isArray(character?.alternateGreetings)
      ? character.alternateGreetings.map(String)
      : [],
    mesExample: String(character?.mesExample || ''),
    tags: Array.isArray(character?.tags) ? character.tags.map(String) : [],
    avatarUri: String(character?.avatarUri || ''),
    bgUri: String(character?.bgUri || ''),
    voiceDisplay: ['text', 'voice-text', 'voice'].includes(character?.voiceDisplay)
      ? character.voiceDisplay
      : 'text',
  };
}

export default function CharacterEditForm({ visible, character, onClose, onSaved }) {
  const { updateCharacter } = useApp();
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [draft, setDraft] = useState(() => emptyDraft(character));
  const [tagDraft, setTagDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(0);
  const imageOperationRef = useRef(0);
  const pendingImageUrisRef = useRef(new Map());
  const mountedRef = useRef(true);
  const characterId = character?.id || '';

  useEffect(() => {
    mountedRef.current = true;
    sessionRef.current += 1;
    imageOperationRef.current += 1;
    pendingImageUrisRef.current.forEach(uri => {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    });
    pendingImageUrisRef.current.clear();
    if (!visible) return undefined;
    setDraft(emptyDraft(character));
    setTagDraft('');
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      imageOperationRef.current += 1;
      pendingImageUrisRef.current.forEach(uri => {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      });
      pendingImageUrisRef.current.clear();
    };
  }, [visible, characterId]);

  const patch = useMemo(() => (key, value) => {
    setDraft(current => ({ ...current, [key]: value }));
  }, []);

  const pickImage = async key => {
    const operation = ++imageOperationRef.current;
    const session = sessionRef.current;
    const isCurrent = () => (
      mountedRef.current
      && imageOperationRef.current === operation
      && sessionRef.current === session
    );
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri || !isCurrent()) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      if (!isCurrent()) return;
      const mime = String(asset.mimeType || '').toLowerCase();
      const ext = mime === 'image/png' || /\.png(?:$|\?)/i.test(asset.uri) ? '.png' : '.jpg';
       const dest = `${dir}${characterId || 'chat'}-${key}-${Date.now()}${ext}`;
       markMediaWrite(dest);
       await FileSystem.copyAsync({ from: asset.uri, to: dest });
      if (!isCurrent()) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
        return;
      }
      const previous = pendingImageUrisRef.current.get(key);
      if (previous && previous !== dest) {
        await FileSystem.deleteAsync(previous, { idempotent: true }).catch(() => {});
      }
      pendingImageUrisRef.current.set(key, dest);
      patch(key, dest);
    } catch (error) {
      if (isCurrent()) Alert.alert(t('character.edit.alert.readImageFailed.title'), t('character.edit.alert.readImageFailed.body'));
    }
  };

  const clearImage = key => {
    const pending = pendingImageUrisRef.current.get(key);
    if (pending) {
      FileSystem.deleteAsync(pending, { idempotent: true }).catch(() => {});
      pendingImageUrisRef.current.delete(key);
    }
    patch(key, '');
  };

  const handleClose = () => {
    if (saving) return;
    sessionRef.current += 1;
    imageOperationRef.current += 1;
    pendingImageUrisRef.current.forEach(uri => {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    });
    pendingImageUrisRef.current.clear();
    onClose();
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    setDraft(current => {
      if ((current.tags || []).includes(tag)) return current;
      return { ...current, tags: [...(current.tags || []), tag] };
    });
    setTagDraft('');
  };

  const removeTag = tag => {
    setDraft(current => ({
      ...current,
      tags: (current.tags || []).filter(item => item !== tag),
    }));
  };

  const addGreeting = () => {
    setDraft(current => ({
      ...current,
      alternateGreetings: [...(current.alternateGreetings || []), ''],
    }));
  };

  const updateGreeting = (index, value) => {
    setDraft(current => ({
      ...current,
      alternateGreetings: (current.alternateGreetings || []).map((item, i) => (
        i === index ? value : item
      )),
    }));
  };

  const removeGreeting = index => {
    setDraft(current => ({
      ...current,
      alternateGreetings: (current.alternateGreetings || []).filter((_, i) => i !== index),
    }));
  };

  const save = async () => {
    if (saving) return;
    const session = sessionRef.current;
    const trimmedPrompt = draft.systemPrompt.trim();
    const next = {
      id: characterId || 'default',
      name: draft.name.trim() || t('character.edit.defaultName'),
      // 「人设/系统提示」允许并保持空白：默认值仅在 chatPipeline 发送时兜底，
      // 用户主动留空的人设不能被覆写成默认卡文案。
      systemPrompt: trimmedPrompt,
      systemPromptComposed: buildSystemPrompt({
        description: draft.description.trim(),
        personality: draft.personality.trim(),
        scenario: draft.scenario.trim(),
        systemPrompt: trimmedPrompt,
        postHistoryInstructions: character?.postHistoryInstructions,
      }),
      description: draft.description.trim(),
      personality: draft.personality.trim(),
      scenario: draft.scenario.trim(),
      firstMes: draft.firstMes.trim(),
      alternateGreetings: draft.alternateGreetings
        .map(item => String(item || '').trim())
        .filter(Boolean),
      mesExample: draft.mesExample.trim(),
      tags: draft.tags,
      avatarUri: draft.avatarUri || '',
      bgUri: draft.bgUri || '',
      voiceDisplay: ['text', 'voice-text', 'voice'].includes(draft.voiceDisplay)
        ? draft.voiceDisplay
        : 'text',
    };
    setSaving(true);
    try {
       await updateCharacter(next);
       if (sessionRef.current === session) {
         if (pendingImageUrisRef.current.get('avatarUri') === next.avatarUri) {
           pendingImageUrisRef.current.delete('avatarUri');
         }
         if (pendingImageUrisRef.current.get('bgUri') === next.bgUri) {
           pendingImageUrisRef.current.delete('bgUri');
         }
         if (typeof onSaved === 'function') onSaved(next);
       }

    } catch (error) {
      Alert.alert(t('character.edit.alert.saveFailed.title'), t('character.edit.alert.saveFailed.body'));
    } finally {
      if (sessionRef.current === session) setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
       onRequestClose={handleClose}

    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('character.edit.title')}</Text>
            <TouchableOpacity onPress={handleClose} disabled={saving} hitSlop={8} accessibilityLabel={t('character.edit.closeA11y')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={!saving}
            pointerEvents={saving ? 'none' : 'auto'}
          >
            <CharacterFormFields
              draft={draft}
              patch={patch}
              styles={styles}
              onPickAvatar={() => pickImage('avatarUri')}
              onPickBg={() => pickImage('bgUri')}
              onClearAvatar={() => clearImage('avatarUri')}
              onClearBg={() => clearImage('bgUri')}
              addGreeting={addGreeting}
              updateGreeting={updateGreeting}
              removeGreeting={removeGreeting}
              tagDraft={tagDraft}
              setTagDraft={setTagDraft}
              addTag={addTag}
              removeTag={removeTag}
            />
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.footerGhost, saving && styles.footerDisabled]}
              onPress={handleClose}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={styles.footerGhostText}>{t('character.edit.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerPrimary, saving && styles.footerDisabled]}
              onPress={save}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Ionicons name="save-outline" size={16} color={theme.colors.text} />
              <Text style={styles.footerPrimaryText}>{saving ? t('character.edit.saving') : t('character.edit.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.overlay,
  },
  sheet: {
    maxHeight: '92%',
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '600' },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
  label: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    marginTop: 14,
    marginBottom: 6,
  },
  multiline: { minHeight: 90, paddingTop: 10 },
  multilineSmall: { minHeight: 64, paddingTop: 10 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(17) },
  imageRow: { flexDirection: 'row', alignItems: 'center' },
  avatarBox: {
    width: 64,
    height: 64,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(22) },
  bgPreview: {
    width: 96,
    height: 64,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  imageActions: { marginLeft: 12 },
  smallButton: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  smallButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  removeText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(13), marginTop: 8 },
  greetingRow: { flexDirection: 'row', alignItems: 'flex-start' },
  greetingInput: { flex: 1 },
  greetingRemove: { paddingLeft: 10, paddingTop: 12 },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  secondaryButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
  voiceRow: { flexDirection: 'row', flexWrap: 'wrap' },
  voiceChip: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  voiceChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryAlpha(0.12),
  },
  voiceChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  voiceChipTextActive: { color: theme.colors.primary, fontWeight: '700' },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  tagChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginRight: 4 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center' },
  tagInput: { flex: 1, minHeight: 40 },
  tagAdd: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  footerGhost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 10,
  },
  footerGhostText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  footerPrimary: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
  },
  footerPrimaryText: { color: theme.colors.text, fontSize: fonts.scaled(14), marginLeft: 6 },
  footerDisabled: { opacity: 0.6 },
});
