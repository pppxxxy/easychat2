import React from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldLabel, TextField } from '../ui/index.js';

// 群聊创建弹层：纯展示组件，创建编排（onCreateGroup）与成员/头像状态仍留在角色库页。
// 依赖全部经 props 注入，渲染树与拆分前逐字一致。
export default function GroupCreateModal({
  visible,
  onClose,
  styles,
  theme,
  t,
  characters,
  groupName,
  setGroupName,
  groupSelected,
  toggleGroupMember,
  groupAvatarUri,
  setGroupAvatarUri,
  groupBgUri,
  setGroupBgUri,
  creatingGroup,
  onCreateGroup,
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
        // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('character.library.group.createTitle')}</Text>
          <FieldLabel style={styles.label}>{t('character.library.group.nameLabel')}</FieldLabel>
          <TextField
            value={groupName}
            onChangeText={setGroupName}
            placeholder={t('group.namePlaceholder')}
            editable={!creatingGroup}
          />
          <FieldLabel style={styles.label}>{t('character.library.group.selectMembers', { count: groupSelected.length })}</FieldLabel>
          <ScrollView style={styles.groupList} keyboardShouldPersistTaps="handled">
            {characters.map(item => {
              const selected = groupSelected.includes(item.id);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.groupRow}
                  onPress={() => toggleGroupMember(item.id)}
                  activeOpacity={0.75}
                >
                  <Ionicons
                    name={selected ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={selected ? theme.colors.primaryMuted : theme.colors.textFaint}
                  />
                  {item.avatarUri ? (
                    <Image source={{ uri: item.avatarUri }} style={styles.groupAvatar} />
                  ) : (
                    <View style={[styles.groupAvatar, styles.groupAvatarFallback]}>
                      <Text style={styles.avatarPlaceholderText}>
                        {String(item.name || '?').charAt(0)}
                      </Text>
                    </View>
                  )}
                  <Text style={styles.groupName} numberOfLines={1}>
                    {item.name || t('common.unnamedCharacter')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {groupSelected.length > 0 ? (
            <>
              <FieldLabel style={styles.label}>{t('character.library.group.avatarLabel')}</FieldLabel>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                <TouchableOpacity
                  style={[styles.groupPickChip, !groupAvatarUri && styles.groupPickChipActive]}
                  onPress={() => setGroupAvatarUri('')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.groupPickText, !groupAvatarUri && styles.groupPickTextActive]}>{t('group.noImage')}</Text>
                </TouchableOpacity>
                {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                  const uri = String(item.avatarUri || '');
                  const active = uri && groupAvatarUri === uri;
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                      onPress={() => setGroupAvatarUri(uri)}
                      activeOpacity={0.8}
                    >
                      {uri ? (
                        <Image source={{ uri }} style={styles.groupPickAvatar} />
                      ) : (
                        <View style={[styles.groupPickAvatar, styles.groupPickAvatarFallback]}>
                          <Text style={styles.avatarPlaceholderText}>{String(item.name || '?').charAt(0)}</Text>
                        </View>
                      )}
                      <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                        {item.name || t('common.unnamedCharacter')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <FieldLabel style={styles.label}>{t('character.library.group.bgLabel')}</FieldLabel>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                <TouchableOpacity
                  style={[styles.groupPickChip, !groupBgUri && styles.groupPickChipActive]}
                  onPress={() => setGroupBgUri('')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.groupPickText, !groupBgUri && styles.groupPickTextActive]}>{t('group.noImage')}</Text>
                </TouchableOpacity>
                {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                  const uri = String(item.bgUri || '');
                  const active = uri && groupBgUri === uri;
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                      onPress={() => {
                        if (!uri) {
                          Alert.alert(
                            t('group.alert.cannotPick.title'),
                            t('character.library.group.noBg.body', { name: item.name || t('character.library.group.theCharacter') })
                          );
                          return;
                        }
                        setGroupBgUri(uri);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                        {item.name || t('common.unnamedCharacter')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          ) : null}
          <View style={styles.presetModalActions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              disabled={creatingGroup}
              activeOpacity={0.8}
            >
              <Text style={[styles.selectButtonText, styles.selectButtonTextGhost]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, creatingGroup && styles.buttonDisabled]}
              onPress={onCreateGroup}
              disabled={creatingGroup}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>
                {creatingGroup ? t('character.library.group.creating') : t('character.library.group.create')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
