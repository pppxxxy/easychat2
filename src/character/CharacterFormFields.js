// 角色表单字段的共享渲染组件。CharacterEditForm（聊天页）与 CharacterDetailScreen
// （详情页）共用同一套字段 JSX，各自保留自己的状态管理（draft vs 详情页表单态）。
// 纯展示：不持有状态，接收 draft 与 patch 回调；样式自带（不依赖调用方传 styles）。

import React from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';

// 字段配置：声明式，key 与 FORGE_FIELDS（cardForge/forge.js）一一对应。
// 新增字段只需在 FORGE_FIELDS 里加 key，这里会自动渲染。
export const PERSONA_FIELDS = [
  { key: 'name', label: '角色名', type: 'text', placeholder: '例如：严谨的代码助手' },
  { key: 'systemPrompt', label: '人设 / 系统提示词', type: 'multiline', placeholder: '描述角色的语气、知识和回答方式' },
  { key: 'description', label: '角色描述', type: 'multiline', placeholder: '角色的背景、外貌与身份设定' },
  { key: 'personality', label: '性格', type: 'multilineSmall', placeholder: '角色的性格特点' },
  { key: 'scenario', label: '场景', type: 'multilineSmall', placeholder: '剧情发生的背景与情境' },
  { key: 'firstMes', label: '开场白', type: 'multilineSmall', placeholder: '角色登场时的第一句话' },
  { key: 'mesExample', label: '对话示例', type: 'multiline', placeholder: '<START>\n{{user}}: 你好\n{{char}}: 你好呀', hint: '对话示例会作为示范注入系统提示词，可用 {{user}} 与 {{char}} 占位。' },
];

// 语音形态三档（与 FORGE_FIELDS 的 voiceDisplay 对应）
export const VOICE_OPTIONS = [
  { value: 'text', label: '仅文字' },
  { value: 'voice-text', label: '语音 + 原文' },
  { value: 'voice', label: '纯语音' },
];

// 自带样式：字段标签、多行输入、图片行、chips、标签等全部内部定义
function useFieldStyles() {
  const { theme, fonts } = useTheme();
  return React.useMemo(() => ({
    label: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), marginTop: 14, marginBottom: 6 },
    multiline: { minHeight: 90, paddingTop: 10 },
    multilineSmall: { minHeight: 64, paddingTop: 10 },
    hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(17) },
    imageRow: { flexDirection: 'row', alignItems: 'center' },
    avatarBox: {
      width: 64, height: 64, borderRadius: 14, overflow: 'hidden',
      backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder,
    },
    avatarImage: { width: '100%', height: '100%' },
    avatarPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    avatarPlaceholderText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(22) },
    bgPreview: {
      width: 96, height: 64, borderRadius: 12,
      backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder,
    },
    imageActions: { marginLeft: 12 },
    smallButton: {
      backgroundColor: theme.colors.surfaceAlt, borderRadius: 9,
      paddingHorizontal: 12, paddingVertical: 8,
      borderWidth: 1, borderColor: theme.colors.surfaceBorder,
    },
    smallButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
    removeText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(13), marginTop: 8 },
    greetingRow: { flexDirection: 'row', alignItems: 'flex-start' },
    greetingInput: { flex: 1 },
    greetingRemove: { paddingLeft: 10, paddingTop: 12 },
    secondaryButton: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      marginTop: 10, paddingVertical: 10, borderRadius: 10,
      borderWidth: 1, borderColor: theme.colors.surfaceBorder, backgroundColor: theme.colors.surface,
    },
    secondaryButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginLeft: 6 },
    voiceRow: { flexDirection: 'row', flexWrap: 'wrap' },
    voiceChip: {
      borderRadius: 14, borderWidth: 1, borderColor: theme.colors.surfaceBorder,
      backgroundColor: theme.colors.surfaceAlt, paddingHorizontal: 12, paddingVertical: 7,
      marginRight: 8, marginBottom: 8,
    },
    voiceChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.12) },
    voiceChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
    voiceChipTextActive: { color: theme.colors.primary, fontWeight: '700' },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
    tagChip: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.surfaceAlt,
      borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8,
      borderWidth: 1, borderColor: theme.colors.surfaceBorder,
    },
    tagChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginRight: 4 },
    tagInputRow: { flexDirection: 'row', alignItems: 'center' },
    tagInput: { flex: 1, minHeight: 40 },
    tagAdd: {
      width: 40, height: 40, borderRadius: 10, backgroundColor: theme.colors.primary,
      alignItems: 'center', justifyContent: 'center', marginLeft: 8,
    },
  }), [theme, fonts]);
}

// 单个字段渲染：text / multiline / multilineSmall 三种 type
export function Field({ field, draft, patch, styles }) {
  const value = draft[field.key] ?? '';
  return (
    <>
      <FieldLabel style={styles.label}>{field.label}</FieldLabel>
      <TextField
        style={field.type === 'text' ? undefined : styles[field.type]}
        value={value}
        onChangeText={text => patch(field.key, text)}
        placeholder={field.placeholder}
        multiline={field.type !== 'text'}
        textAlignVertical={field.type !== 'text' ? 'top' : undefined}
      />
      {field.hint ? <FieldHint style={styles.hint}>{field.hint}</FieldHint> : null}
    </>
  );
}

// 头像/背景图行
export function ImagePickerRow({ label, imageUri, onPick, onClear, styles, placeholderText }) {
  // 图片行用 onPick/onClear 直接操作，不走 patch（patch 用于文本字段）

  return (
    <>
      <FieldLabel style={styles.label}>{label}</FieldLabel>
      <View style={styles.imageRow}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarPlaceholderText}>{placeholderText}</Text>
          </View>
        )}
        <View style={styles.imageActions}>
          <TouchableOpacity style={styles.smallButton} onPress={onPick} activeOpacity={0.8}>
            <Text style={styles.smallButtonText}>{imageUri ? '更换' : '选择'}</Text>
          </TouchableOpacity>
          {imageUri ? (
            <TouchableOpacity onPress={onClear} hitSlop={8}>
              <Text style={styles.removeText}>清除</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </>
  );
}

// 备用开场白列表
export function GreetingList({ draft, styles, addGreeting, updateGreeting, removeGreeting }) {
  const { theme } = useTheme();
  return (
    <>
      <FieldLabel style={styles.label}>备用开场白</FieldLabel>
      {draft.alternateGreetings.map((item, index) => (
        <View key={`greeting-${index}`} style={styles.greetingRow}>
          <TextField
            style={[styles.multilineSmall, styles.greetingInput]}
            value={item}
            onChangeText={value => updateGreeting(index, value)}
            placeholder={`备用开场白 ${index + 1}`}
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={styles.greetingRemove}
            onPress={() => removeGreeting(index)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="删除备用开场白"
          >
            <Ionicons name="close" size={16} color={theme.colors.dangerSoft} />
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity style={styles.secondaryButton} onPress={addGreeting} activeOpacity={0.8}>
        <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
        <Text style={styles.secondaryButtonText}>添加备用开场白</Text>
      </TouchableOpacity>
    </>
  );
}

// 语音形态三档选择
export function VoiceSelector({ draft, patch, styles }) {
  return (
    <>
      <FieldLabel style={styles.label}>语音形态</FieldLabel>
      <View style={styles.voiceRow}>
        {VOICE_OPTIONS.map(option => {
          const active = draft.voiceDisplay === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[styles.voiceChip, active && styles.voiceChipActive]}
              onPress={() => patch('voiceDisplay', option.value)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`语音形态 ${option.label}`}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.voiceChipText, active && styles.voiceChipTextActive]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <FieldHint style={styles.hint}>纯语音会隐藏回复正文（仍计入对话与记忆）；语音合成失败时自动退回仅文字。</FieldHint>
    </>
  );
}

// 标签编辑器
export function TagEditor({ draft, styles, tagDraft, setTagDraft, addTag, removeTag }) {
  const { theme } = useTheme();
  return (
    <>
      <FieldLabel style={styles.label}>标签</FieldLabel>
      <View style={styles.tagRow}>
        {draft.tags.map(tag => (
          <TouchableOpacity
            key={tag}
            style={styles.tagChip}
            onPress={() => removeTag(tag)}
            activeOpacity={0.8}
          >
            <Text style={styles.tagChipText}>{tag}</Text>
            <Ionicons name="close" size={12} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.tagInputRow}>
        <TextField
          style={styles.tagInput}
          value={tagDraft}
          onChangeText={setTagDraft}
          onSubmitEditing={addTag}
          placeholder="输入标签后回车添加"
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.tagAdd} onPress={addTag} activeOpacity={0.8}>
          <Ionicons name="add" size={18} color={theme.colors.primaryContrast} />
        </TouchableOpacity>
      </View>
    </>
  );
}

// 完整表单渲染：调用方传入 draft、patch、以及各 handler
export function CharacterFormFields({
  draft,
  patch,
  onPickAvatar,
  onPickBg,
  onClearAvatar,
  onClearBg,
  addGreeting,
  updateGreeting,
  removeGreeting,
  tagDraft,
  setTagDraft,
  addTag,
  removeTag,
  fields = PERSONA_FIELDS,
}) {
  const styles = useFieldStyles();
  const nameChar = (draft.name || '?').charAt(0);
  return (
    <>
      {fields.map(field => (
        <Field key={field.key} field={field} draft={draft} patch={patch} styles={styles} />
      ))}
      <ImagePickerRow
        label="角色头像"
        imageUri={draft.avatarUri}
        onPick={onPickAvatar}
        onClear={onClearAvatar}
        styles={styles}
        placeholderText={nameChar}
      />
      <ImagePickerRow
        label="背景图"
        imageUri={draft.bgUri}
        onPick={onPickBg}
        onClear={onClearBg}
        styles={styles}
        placeholderText=""
      />
      <GreetingList
        draft={draft}
        patch={patch}
        styles={styles}
        addGreeting={addGreeting}
        updateGreeting={updateGreeting}
        removeGreeting={removeGreeting}
      />
      <VoiceSelector draft={draft} patch={patch} styles={styles} />
      <TagEditor
        draft={draft}
        patch={patch}
        styles={styles}
        tagDraft={tagDraft}
        setTagDraft={setTagDraft}
        addTag={addTag}
        removeTag={removeTag}
      />
      <FieldHint style={styles.hint}>世界书与正则脚本请在「角色」页编辑。</FieldHint>
    </>
  );
}
