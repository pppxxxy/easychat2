import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
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
import * as FileSystem from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';

import { updateSessionInfo } from './storage';
import { FieldLabel, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

export default function GroupEditForm({ visible, session, members, onClose, onSaved }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [name, setName] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [bgUri, setBgUri] = useState('');
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(0);
  const sessionId = session?.id || '';

  useEffect(() => {
    if (!visible) return;
    sessionRef.current += 1;
    setName(String(session?.name || ''));
    setAvatarUri(String(session?.avatarUri || ''));
    setBgUri(String(session?.bgUri || ''));
  }, [visible, sessionId]);

  const memberList = (Array.isArray(members) ? members : []).filter(item => item && item.id);

  const pickImage = async setter => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const ext = asset.uri.endsWith('.png') ? '.png' : '.jpg';
      const dest = `${dir}${sessionId || 'group'}-group-${Date.now()}${ext}`;
      await FileSystem.copyAsync({ from: asset.uri, to: dest });
      setter(dest);
    } catch (error) {
      Alert.alert('图片读取失败', '请重试。');
    }
  };

  const save = async () => {
    if (saving || !sessionId) return;
    const stamp = sessionRef.current;
    setSaving(true);
    try {
      await updateSessionInfo(sessionId, {
        name: name.trim(),
        avatarUri,
        bgUri,
      });
      if (sessionRef.current === stamp && typeof onSaved === 'function') onSaved();
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限，已填内容不会丢失。');
    } finally {
      if (sessionRef.current === stamp) setSaving(false);
    }
  };

  const renderMemberPicks = (current, setter, label) => (
    <>
      <FieldLabel style={styles.label}>{label}</FieldLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickRow}>
        <TouchableOpacity
          style={[styles.pickChip, !current && styles.pickChipActive]}
          onPress={() => setter('')}
          activeOpacity={0.8}
        >
          <Text style={[styles.pickChipText, !current && styles.pickChipTextActive]}>不使用</Text>
        </TouchableOpacity>
        {memberList.map(item => {
          const uri = String(item.avatarUri || '');
          const active = current === uri && !!uri;
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.pickChip, active && styles.pickChipActive]}
              onPress={() => {
                if (!uri) {
                  Alert.alert('无法选择', `「${item.name || '该角色'}」没有头像。`);
                  return;
                }
                setter(uri);
              }}
              activeOpacity={0.8}
            >
              {uri ? (
                <Image source={{ uri }} style={styles.pickAvatar} />
              ) : (
                <View style={[styles.pickAvatar, styles.pickAvatarFallback]}>
                  <Text style={styles.pickAvatarText}>
                    {String(item.name || '?').charAt(0)}
                  </Text>
                </View>
              )}
              <Text style={[styles.pickChipText, active && styles.pickChipTextActive]} numberOfLines={1}>
                {item.name || '未命名'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>群聊设置</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <FieldLabel style={styles.label}>群名</FieldLabel>
            <TextField
              value={name}
              onChangeText={setName}
              placeholder="例如：周末闲聊群"
            />

            <FieldLabel style={styles.label}>群头像</FieldLabel>
            <View style={styles.previewRow}>
              <View style={styles.previewBoxRound}>
                {avatarUri ? (
                  <Image source={{ uri: avatarUri }} style={styles.previewImage} />
                ) : (
                  <Ionicons name="people" size={22} color={theme.colors.primarySoft} />
                )}
              </View>
              <View style={styles.previewActions}>
                <TouchableOpacity style={styles.smallButton} onPress={() => pickImage(setAvatarUri)} activeOpacity={0.8}>
                  <Text style={styles.smallButtonText}>选择图片</Text>
                </TouchableOpacity>
                {avatarUri ? (
                  <TouchableOpacity onPress={() => setAvatarUri('')} hitSlop={8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            {renderMemberPicks(avatarUri, setAvatarUri, '或用成员头像')}

            <FieldLabel style={styles.label}>群背景</FieldLabel>
            <View style={styles.previewRow}>
              <View style={styles.previewBoxWide}>
                {bgUri ? (
                  <Image source={{ uri: bgUri }} style={styles.previewImage} />
                ) : (
                  <Text style={styles.previewEmpty}>无背景</Text>
                )}
              </View>
              <View style={styles.previewActions}>
                <TouchableOpacity style={styles.smallButton} onPress={() => pickImage(setBgUri)} activeOpacity={0.8}>
                  <Text style={styles.smallButtonText}>选择图片</Text>
                </TouchableOpacity>
                {bgUri ? (
                  <TouchableOpacity onPress={() => setBgUri('')} hitSlop={8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            {renderMemberPicks(bgUri, setBgUri, '或用成员背景')}
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity style={styles.footerGhost} onPress={onClose} activeOpacity={0.8}>
              <Text style={styles.footerGhostText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerPrimary, saving && styles.footerDisabled]}
              onPress={save}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Ionicons name="save-outline" size={16} color={theme.colors.text} />
              <Text style={styles.footerPrimaryText}>{saving ? '保存中...' : '保存'}</Text>
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
  label: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), marginTop: 14, marginBottom: 6 },
  previewRow: { flexDirection: 'row', alignItems: 'center' },
  previewBoxRound: {
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  previewBoxWide: {
    width: 120,
    height: 64,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  previewImage: { width: '100%', height: '100%' },
  previewEmpty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  previewActions: { marginLeft: 12 },
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
  pickRow: { flexGrow: 0, marginTop: 2 },
  pickChip: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  pickChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySoft },
  pickChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 4 },
  pickChipTextActive: { color: theme.colors.primaryContrast },
  pickAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.colors.surfaceAlt },
  pickAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  pickAvatarText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(15) },
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