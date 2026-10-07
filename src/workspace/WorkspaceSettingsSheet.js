// 工作区设置列表面板：把原先散在面板各处的设置收成「底部一个按钮 + 一个列表」。
//
// 设计约定：
// - 就地展开：模型 / 思考强度 / 工作模式 / 角色 / 上下文占用都能在这一层点选或查看，
//   不用跳到别的页面；导入文件是直接动作，导出 / 环境配置 / 查找历史交给
//   WorkspacePanel 对应的子面板（那里已经有完整的文件系统能力）。
// - 纯展示 + 回调：所有状态由 WorkspaceChat 持有，这里不自己读写存储，
//   避免同一份设置在两处各存一份后不同步。

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

const THINKING_CHOICES = ['off', 'low', 'medium', 'high'];
const MODE_CHOICES = ['ask', 'read', 'write'];

// token 数的紧凑显示（估算值，K 足够）。
function formatTokens(value) {
  const tokens = Number(value) || 0;
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}K`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function Chip({ label, active, onPress, styles }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function WorkspaceSettingsSheet({
  visible,
  onClose,
  section = '',
  onToggleSection,
  models = [],
  activeModel = '',
  onSelectModel,
  thinking = { enabled: false, level: 'medium' },
  onSelectThinking,
  mode = 'ask',
  onSelectMode,
  characters = [],
  characterId = '',
  onSelectCharacter,
  usage = null,
  onImportFile,
  importBusy = false,
  onOpenPanel,
  embedded = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const thinkingKey = thinking && thinking.enabled === true ? String(thinking.level || 'medium') : 'off';
  const activeCharacter = (Array.isArray(characters) ? characters : [])
    .find(item => item && item.id === characterId) || null;

  const rows = [
    {
      id: 'model',
      icon: 'cube-outline',
      label: t('workspace.settings.model'),
      value: activeModel || t('workspace.settings.model.empty'),
    },
    {
      id: 'thinking',
      icon: 'bulb-outline',
      label: t('workspace.settings.thinking'),
      value: t(`workspace.panel.thinking.${thinkingKey}`),
    },
    {
      id: 'mode',
      icon: 'options-outline',
      label: t('workspace.settings.mode'),
      value: t(`settings.workspace.mode.${MODE_CHOICES.includes(mode) ? mode : 'ask'}`),
    },
    {
      id: 'character',
      icon: 'person-circle-outline',
      label: t('workspace.settings.character'),
      value: (activeCharacter && activeCharacter.name) || t('workspace.settings.character.none'),
    },
    {
      id: 'usage',
      icon: 'analytics-outline',
      label: t('workspace.settings.usage'),
      value: usage ? `${Math.round((usage.ratio || 0) * 100)}%` : t('workspace.settings.usage.empty'),
    },
  ];

  const renderBody = id => {
    if (id === 'model') {
      if (models.length === 0) {
        return <Text style={styles.bodyHint}>{t('workspace.settings.model.empty')}</Text>;
      }
      return (
        <View style={styles.chipWrap}>
          {models.map(name => (
            <Chip
              key={name}
              label={name}
              active={String(name) === String(activeModel)}
              onPress={() => onSelectModel && onSelectModel(name)}
              styles={styles}
              theme={theme}
            />
          ))}
        </View>
      );
    }
    if (id === 'thinking') {
      return (
        <View>
          <View style={styles.chipWrap}>
            {THINKING_CHOICES.map(choice => (
              <Chip
                key={choice}
                label={t(`workspace.panel.thinking.${choice}`)}
                active={thinkingKey === choice}
                onPress={() => onSelectThinking && onSelectThinking(choice)}
                styles={styles}
                theme={theme}
              />
            ))}
          </View>
          <Text style={styles.bodyHint}>{t('workspace.panel.thinking.hint')}</Text>
        </View>
      );
    }
    if (id === 'mode') {
      return (
        <View>
          <View style={styles.chipWrap}>
            {MODE_CHOICES.map(choice => (
              <Chip
                key={choice}
                label={t(`settings.workspace.mode.${choice}`)}
                active={mode === choice}
                onPress={() => onSelectMode && onSelectMode(choice)}
                styles={styles}
                theme={theme}
              />
            ))}
          </View>
          <Text style={styles.bodyHint}>
            {t(`settings.workspace.hint.${MODE_CHOICES.includes(mode) ? mode : 'ask'}`)}
          </Text>
        </View>
      );
    }
    if (id === 'character') {
      if (characters.length === 0) {
        return <Text style={styles.bodyHint}>{t('workspace.settings.character.none')}</Text>;
      }
      return (
        <View style={styles.chipWrap}>
          {characters.map(item => (
            <Chip
              key={item.id}
              label={item.name || item.id}
              active={String(item.id) === String(characterId)}
              onPress={() => onSelectCharacter && onSelectCharacter(item.id)}
              styles={styles}
              theme={theme}
            />
          ))}
        </View>
      );
    }
    if (id === 'usage') {
      if (!usage) {
        return <Text style={styles.bodyHint}>{t('workspace.panel.context.empty')}</Text>;
      }
      const percent = Math.round((usage.ratio || 0) * 100);
      const warn = (usage.ratio || 0) >= 0.8;
      return (
        <View>
          <View style={styles.usageTrack}>
            <View
              style={[
                styles.usageFill,
                { width: `${Math.max(0, Math.min(100, percent))}%` },
                warn && styles.usageFillWarn,
              ]}
            />
          </View>
          <Text style={styles.bodyHint}>
            {t('workspace.panel.context.usage', {
              tokens: formatTokens(usage.tokens),
              window: formatTokens(usage.window),
              percent,
            })}
          </Text>
          <Text style={styles.bodyHint}>{t('workspace.panel.context.hint')}</Text>
        </View>
      );
    }
    return null;
  };

  const actionRows = [
    {
      id: 'import',
      icon: 'download-outline',
      label: t('workspace.settings.import'),
      hint: t('workspace.settings.import.hint'),
      busy: importBusy,
      onPress: () => onImportFile && onImportFile(),
    },
    {
      id: 'export',
      icon: 'document-text-outline',
      label: t('workspace.settings.export'),
      hint: t('workspace.settings.export.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('docx');
      },
    },
    {
      id: 'history',
      icon: 'folder-open-outline',
      label: t('workspace.settings.files'),
      hint: t('workspace.settings.history.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('viewer');
      },
    },
    {
      id: 'env',
      icon: 'construct-outline',
      label: t('workspace.settings.env'),
      hint: t('workspace.settings.env.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('catalog');
      },
    },
  ];

  // 面板内容抽出：embedded（对话面板内嵌）与 Modal 两种外壳共用，避免两处漂移。
  const sheetContent = (
    <>
            {rows.map(row => {
              const expanded = section === row.id;
              return (
                <View key={row.id}>
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => onToggleSection && onToggleSection(expanded ? '' : row.id)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name={row.icon} size={17} color={theme.colors.primarySoft} />
                    <Text style={styles.rowLabel}>{row.label}</Text>
                    <Text style={styles.rowValue} numberOfLines={1}>{row.value}</Text>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={15}
                      color={theme.colors.textFaint}
                    />
                  </TouchableOpacity>
                  {expanded ? <View style={styles.rowBody}>{renderBody(row.id)}</View> : null}
                </View>
              );
            })}

            <View style={styles.divider} />

            {actionRows.map(row => (
              <TouchableOpacity
                key={row.id}
                style={styles.row}
                onPress={row.busy ? undefined : row.onPress}
                activeOpacity={0.8}
                disabled={row.busy}
              >
                <Ionicons name={row.icon} size={17} color={theme.colors.primarySoft} />
                <View style={styles.actionTextBlock}>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <Text style={styles.actionHint}>{row.hint}</Text>
                </View>
                {row.busy
                  ? <ActivityIndicator size="small" color={theme.colors.primary} />
                  : <Ionicons name="chevron-forward" size={15} color={theme.colors.textFaint} />}
              </TouchableOpacity>
            ))}
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedRoot}>{sheetContent}</View>;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('workspace.settings.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
            {sheetContent}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  // embedded：作为对话面板内的设置层，不再有遮罩与底部弹层外壳。
  embeddedRoot: { paddingHorizontal: 4 },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '78%',
    paddingBottom: 8,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  sheetTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingHorizontal: 12, paddingBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  rowLabel: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 10 },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginHorizontal: 10,
  },
  actionTextBlock: { flex: 1, marginLeft: 10, marginRight: 8 },
  actionHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
  },
  rowBody: {
    paddingHorizontal: 4,
    paddingBottom: 12,
    paddingTop: 2,
  },
  bodyHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 8,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  chip: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 11,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: {
    backgroundColor: theme.colors.primaryAlpha(0.2),
    borderColor: theme.colors.primary,
  },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primarySoft },
  usageTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
    marginTop: 6,
  },
  usageFill: { height: '100%', backgroundColor: theme.colors.primary },
  usageFillWarn: { backgroundColor: theme.colors.danger || theme.colors.primary },
  divider: { height: tokens.border.thin, backgroundColor: theme.colors.surfaceBorder, marginVertical: 4 },
});
