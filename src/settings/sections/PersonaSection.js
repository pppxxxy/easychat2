import React from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  FieldLabel,
  SecondaryButton,
  TextField,
} from '../../ui/index.js';

export default function PersonaSection(props) {
  const {
    styles,
    theme,
    userName,
    setUserName,
    userPersona,
    setUserPersona,
    userAvatarUri,
    userProfileSaved,
    personas,
    setPersonas,
    activePersonaId,
    saveUserProfileDelayed,
    changeUserAvatar,
    selectPersona,
    addPersona,
    removePersona,
    pickUserAvatar,
    saveUserProfileNow,
  } = props;
  return (
    <>
          <Text style={styles.fieldHint}>
            这里的信息会被注入到提示词中，角色的正则脚本可以通过 {"{{user}}"} 引用你的名字。头像为全部人设共用。
          </Text>
          <FieldLabel style={styles.label}>我的身份</FieldLabel>
          <CollapsibleSelect
            label="当前人设"
            value={activePersonaId}
            valueMeta={userPersona ? userPersona.slice(0, 40) : '未填写描述'}
            options={personas.map(item => ({
              value: item.id,
              label: String(item.userName || '').trim() || '未命名人设',
              meta: String(item.persona || '').trim().slice(0, 40) || '未填写描述',
            }))}
            onSelect={id => selectPersona(id)}
            placeholder="未选择人设"
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addPersona} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>新增人设</Text>
            </TouchableOpacity>
            {personas.length > 1 ? (
              <TouchableOpacity
                style={styles.personaAddChip}
                onPress={() => removePersona(activePersonaId)}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>删除当前</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.avatarRow}>
            <View style={styles.avatarBox}>
              {userAvatarUri ? (
                <Image source={{ uri: userAvatarUri }} style={styles.avatarImg} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarPlaceholderText}>
                    {userName ? userName.charAt(0) : '我'}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.imageActions}>
              <TouchableOpacity style={styles.smallButton} onPress={pickUserAvatar} activeOpacity={0.8}>
                <Text style={styles.smallButtonText}>{userAvatarUri ? '更换头像' : '选择头像'}</Text>
              </TouchableOpacity>
              {userAvatarUri ? (
                <TouchableOpacity onPress={() => changeUserAvatar('')} hitSlop={8}>
                  <Text style={styles.removeText}>清除</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
          <FieldLabel style={styles.label}>人设名称（当前人设）</FieldLabel>
          <TextField
            value={userName}
            onChangeText={text => {
              setUserName(text);
              setPersonas(list => list.map(item => (
                item.id === activePersonaId ? { ...item, userName: text } : item
              )));
              saveUserProfileDelayed(text, userPersona, userAvatarUri);
            }}
            placeholder="例如：小明"
          />
          <FieldLabel style={styles.label}>人设描述</FieldLabel>
          <TextField
            style={styles.multilineInput}
            value={userPersona}
            onChangeText={text => { setUserPersona(text); saveUserProfileDelayed(userName, text, userAvatarUri); }}
            placeholder="描述你自己的性格、背景、喜好等"
            multiline
            textAlignVertical="top"
          />
          <SecondaryButton
            title="保存用户人设"
            icon="save-outline"
            onPress={saveUserProfileNow}
            style={styles.actionBtn}
          />
          {userProfileSaved ? <Text style={styles.savedHint}>已自动保存</Text> : null}
    </>
  );
}
