// 工作区设置列表面板：把原先散在面板各处的设置收成「底部一个按钮 + 一个列表」。
//
// 设计约定：
// - 就地展开：模型 / 思考强度 / 工作模式 / 角色 / 上下文占用都能在这一层点选或查看，
//   不用跳到别的页面；导入文件是直接动作，导出 / 环境配置 / 查找历史交给
//   WorkspacePanel 对应的子面板（那里已经有完整的文件系统能力）。
// - 纯展示 + 回调：所有状态由 WorkspaceChat 持有，这里不自己读写存储，
//   避免同一份设置在两处各存一份后不同步。

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { describePermissionRule, normalizePermissionRule, PERMISSION_EFFECTS } from '../agent/permissions.js';
import { DEFAULT_RETENTION, RETENTION_BOUNDS, normalizeRetention } from './retention.js';
import { COMMANDS_DIR } from './commands.js';
import { HOOKS_FILE, HOOK_EVENTS, parseWorkspaceHooks, validateWorkspaceHooks } from './hooks.js';
import { SKILLS_DIR } from './skills.js';
import { WORKSPACE_TEMPLATES } from './templates.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

const THINKING_CHOICES = ['off', 'low', 'medium', 'high'];
const MODE_CHOICES = ['ask', 'read', 'write'];
// P0-8：校验原因（机器 token 带连字符）→ i18n 词条名（只允许字母数字与点）。
const HOOK_ERROR_KEYS = {
  'invalid-json': 'invalidJson',
  'not-object': 'notObject',
  'unknown-event': 'unknownEvent',
  'not-array': 'notArray',
  'invalid-item': 'invalidItem',
  'invalid-regex': 'invalidRegex',
  'too-many': 'tooMany',
  'too-long': 'tooLong',
};

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
  // 已记住的授权（本次会话 + 永久）与清除入口：数据仍由 ChatPanel 持有
  // （本面板只展示 + 转发回调，见文件头「纯展示」约定）。
  permissionRules = [],
  onClearPermissionRules,
  // P0-6：手写规则的创建入口（存储写入仍由宿主做——本面板只收集草稿 + 转发）。
  onAddPermissionRule,
  // P1-11：保留口径（写前快照条数 / 回滚基线份数 / 会话事件流上限）。同样是
  // 「面板收集草稿 → 宿主落盘」，面板不自己读写存储。
  retention = DEFAULT_RETENTION,
  onChangeRetention,
  // 技能清单（SKILL.md 渐进披露）；安装示例同样是转发给 ChatPanel 的动作。
  skills = [],
  onInstallSampleSkills,
  // 斜杠命令（输入框建议列表的数据源）；安装示例沿用技能那一套。
  commands = [],
  onInstallSampleCommands,
  // 工作区模板（T9）：一键铺起始文件（幂等不覆盖），创建动作转发给 ChatPanel。
  onInstallTemplate,
  // E4：会话事件流导出（读/写/分享全在 ChatPanel——本面板只转发动作）。
  onExportSessionEvents,
  // P0-8：hooks.json 原文（宿主读好传进来，本面板用纯函数校验与统计）与安装示例回调。
  hooksText = '',
  onInstallSampleHooks,
  embedded = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const thinkingKey = thinking && thinking.enabled === true ? String(thinking.level || 'medium') : 'off';
  const activeCharacter = (Array.isArray(characters) ? characters : [])
    .find(item => item && item.id === characterId) || null;
  const retentionEffective = normalizeRetention(retention);

  // P0-6：手写规则的草稿。只是输入态（不落盘、不进设置）——落盘由宿主的
  // onAddPermissionRule 走 addPermissionRule，与弹框「永远允许」同一条链路。
  // 默认「必须先问」：这是原本**写不出来**的那一档（allow 有弹框、deny 有 hooks.json），
  // 也比重放行保守。
  const [ruleEffect, setRuleEffect] = useState('ask');
  const [ruleTool, setRuleTool] = useState('');
  const [ruleMatch, setRuleMatch] = useState('');
  // 复用规则引擎的归一（空工具名 → null = 不给提交，与存储层同一口径）。
  const ruleDraft = normalizePermissionRule({
    effect: ruleEffect,
    tool: ruleTool,
    match: ruleMatch,
    scope: 'always',
  });
  const submitRule = () => {
    if (!ruleDraft) return;
    if (onAddPermissionRule) onAddPermissionRule(ruleDraft);
    setRuleTool('');
    setRuleMatch('');
  };

  // P1-11：保留口径的草稿（字符串）。**不逐键归一**——用户敲「1」再敲「2」时，
  // 逐键夹区间会把「1」立刻改成下限 10，输入框自己跟自己打架。失焦/提交时才归一。
  const [retentionDraft, setRetentionDraft] = useState(null);
  const retentionValue = key => (
    retentionDraft && retentionDraft[key] !== undefined
      ? retentionDraft[key]
      : String(normalizeRetention(retention)[key])
  );
  const commitRetention = () => {
    const next = normalizeRetention({
      historyKeep: retentionValue('historyKeep'),
      rollbackKeep: retentionValue('rollbackKeep'),
      sessionEventsMaxKb: retentionValue('sessionEventsMaxKb'),
    });
    setRetentionDraft(null);
    if (onChangeRetention) onChangeRetention(next);
  };
  const retentionRows = [
    { key: 'historyKeep', label: t('workspace.settings.retention.historyKeep'), bounds: RETENTION_BOUNDS.historyKeep },
    { key: 'rollbackKeep', label: t('workspace.settings.retention.rollbackKeep'), bounds: RETENTION_BOUNDS.rollbackKeep },
    { key: 'sessionEventsMaxKb', label: t('workspace.settings.retention.sessionEventsMaxKb'), bounds: RETENTION_BOUNDS.sessionEventsMaxKb },
  ];

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
    {
      // P1-11：旁路数据的保留口径（三个上限）。摘要用生效值，改完立即反映。
      id: 'retention',
      icon: 'archive-outline',
      label: t('workspace.settings.retention'),
      value: t('workspace.settings.retention.value', {
        history: retentionEffective.historyKeep,
        rollback: retentionEffective.rollbackKeep,
        kb: retentionEffective.sessionEventsMaxKb,
      }),
    },
    {
      id: 'skills',
      icon: 'sparkles-outline',
      label: t('workspace.settings.skills'),
      value: skills.length > 0
        ? t('workspace.settings.skills.count', { count: skills.length })
        : t('workspace.settings.skills.emptyShort'),
    },
    {
      id: 'commands',
      icon: 'terminal-outline',
      label: t('workspace.settings.commands'),
      value: commands.length > 0
        ? t('workspace.settings.commands.count', { count: commands.length })
        : t('workspace.settings.commands.emptyShort'),
    },
    {
      id: 'permissions',
      icon: 'shield-checkmark-outline',
      label: t('workspace.settings.permissions'),
      value: permissionRules.length > 0
        ? t('workspace.settings.permissions.count', { count: permissionRules.length })
        : t('workspace.settings.permissions.emptyShort'),
    },
    {
      id: 'hooks',
      icon: 'git-branch-outline',
      label: t('workspace.settings.hooks'),
      value: (() => {
        const parsed = parseWorkspaceHooks(hooksText);
        const count = HOOK_EVENTS.reduce((sum, event) => sum + (Array.isArray(parsed[event]) ? parsed[event].length : 0), 0);
        return count > 0 ? t('workspace.settings.hooks.count', { count }) : 'hooks.json';
      })(),
    },
    {
      id: 'templates',
      icon: 'layers-outline',
      label: t('workspace.settings.templates'),
      value: t('workspace.settings.templates.count', { count: WORKSPACE_TEMPLATES.length }),
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
    if (id === 'retention') {
      return (
        <View>
          <Text style={styles.bodyHint}>{t('workspace.settings.retention.hint')}</Text>
          {retentionRows.map(row => (
            <View key={row.key} style={styles.retentionRow}>
              <Text style={styles.retentionLabel}>
                {row.label}
                <Text style={styles.retentionRange}>
                  {`  ${t('workspace.settings.retention.range', { min: row.bounds.min, max: row.bounds.max })}`}
                </Text>
              </Text>
              <TextInput
                style={styles.sheetInput}
                value={retentionValue(row.key)}
                onChangeText={text => setRetentionDraft({ ...(retentionDraft || {}), [row.key]: text })}
                onBlur={commitRetention}
                onSubmitEditing={commitRetention}
                keyboardType="number-pad"
                placeholder={String(retentionEffective[row.key])}
                placeholderTextColor={theme.colors.textFaint}
              />
            </View>
          ))}
          <TouchableOpacity
            style={styles.permissionAdd}
            onPress={commitRetention}
            activeOpacity={0.8}
          >
            <Ionicons name="save-outline" size={15} color={theme.colors.primary} />
            <Text style={styles.permissionAddText}>{t('workspace.settings.retention.save')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (id === 'skills') {
      return (
        <View>
          <Text style={styles.bodyHint}>{t('workspace.settings.skills.hint', { dir: SKILLS_DIR })}</Text>
          {skills.length === 0 ? (
            <Text style={styles.bodyHint}>{t('workspace.settings.skills.empty')}</Text>
          ) : skills.map((item, index) => (
            <Text key={`${String(item && item.name)}-${index}`} style={styles.bodyHint} selectable>
              {String(item && item.name || '')}
              {'：'}
              {String(item && item.description || '') || t('workspace.settings.skills.noDescription')}
            </Text>
          ))}
          <TouchableOpacity
            style={styles.skillsInstall}
            onPress={() => onInstallSampleSkills && onInstallSampleSkills()}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={15} color={theme.colors.primary} />
            <Text style={styles.skillsInstallText}>{t('workspace.settings.skills.install')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (id === 'templates') {
      return (
        <View>
          <Text style={styles.bodyHint}>{t('workspace.settings.templates.hint')}</Text>
          {WORKSPACE_TEMPLATES.map(template => (
            <View key={template.id} style={styles.templateRow}>
              <View style={styles.templateInfo}>
                <Text style={styles.templateName}>{t(template.nameKey)}</Text>
                <Text style={styles.templateDescription}>{t(template.descriptionKey)}</Text>
              </View>
              <TouchableOpacity
                style={styles.templateCreate}
                onPress={() => onInstallTemplate && onInstallTemplate(template.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.templateCreateText}>{t('workspace.settings.templates.create')}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      );
    }
    if (id === 'hooks') {
      // P0-8：hooks 面板——路径 + 校验结果 + 事件清单 + 安装示例。
      // 数据由宿主读好传进来（本面板只展示 + 转发回调，见文件头约定）。
      const validation = validateWorkspaceHooks(hooksText);
      const parsed = parseWorkspaceHooks(hooksText);
      const hookRows = HOOK_EVENTS
        .map(event => ({ event, count: Array.isArray(parsed[event]) ? parsed[event].length : 0 }))
        .filter(item => item.count > 0);
      return (
        <View>
          <Text style={styles.bodyHint} selectable>{t('workspace.settings.hooks.hint', { file: HOOKS_FILE })}</Text>
          {hookRows.length === 0 ? (
            <Text style={styles.bodyHint}>{t('workspace.settings.hooks.empty')}</Text>
          ) : hookRows.map(item => (
            <Text key={item.event} style={styles.bodyHint} selectable>
              {t('workspace.settings.hooks.entry', { event: item.event, count: item.count })}
            </Text>
          ))}
          {validation.errors.map((error, index) => (
            <Text key={`${error.event}-${error.index}-${index}`} style={styles.permissionClearText}>
              {t('workspace.settings.hooks.error', {
                event: error.event || t('workspace.settings.hooks.errorRoot'),
                index: error.index + 1,
                reason: t(`workspace.settings.hooks.reason.${HOOK_ERROR_KEYS[error.reason] || 'unknown'}`),
              })}
            </Text>
          ))}
          <TouchableOpacity
            style={styles.skillsInstall}
            onPress={() => onInstallSampleHooks && onInstallSampleHooks()}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={15} color={theme.colors.primary} />
            <Text style={styles.skillsInstallText}>{t('workspace.settings.hooks.install')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (id === 'commands') {
      return (
        <View>
          <Text style={styles.bodyHint}>{t('workspace.settings.commands.hint', { dir: COMMANDS_DIR })}</Text>
          {commands.length === 0 ? (
            <Text style={styles.bodyHint}>{t('workspace.settings.commands.empty')}</Text>
          ) : commands.map((item, index) => (
            <Text key={`${String(item && item.name)}-${index}`} style={styles.bodyHint} selectable>
              {'/'}
              {String(item && item.name || '')}
              {String(item && item.description || '') ? `：${item.description}` : ''}
            </Text>
          ))}
          <TouchableOpacity
            style={styles.skillsInstall}
            onPress={() => onInstallSampleCommands && onInstallSampleCommands()}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={15} color={theme.colors.primary} />
            <Text style={styles.skillsInstallText}>{t('workspace.settings.commands.install')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (id === 'permissions') {
      return (
        <View>
          <Text style={styles.bodyHint}>{t('workspace.settings.permissions.hint')}</Text>
          {permissionRules.length === 0 ? (
            <Text style={styles.bodyHint}>{t('workspace.settings.permissions.empty')}</Text>
          ) : permissionRules.map((rule, index) => (
            <Text key={`${String(rule && rule.tool)}-${index}`} style={styles.bodyHint} selectable>
              {rule && rule.scope === 'session'
                ? t('workspace.settings.permissions.scope.session')
                : t('workspace.settings.permissions.scope.always')}
              {' · '}
              {describePermissionRule(rule, t)}
            </Text>
          ))}
          {permissionRules.length > 0 ? (
            <TouchableOpacity
              style={styles.permissionClear}
              onPress={() => onClearPermissionRules && onClearPermissionRules()}
              activeOpacity={0.8}
            >
              <Ionicons name="trash-outline" size={15} color={theme.colors.danger} />
              <Text style={styles.permissionClearText}>{t('workspace.settings.permissions.clear')}</Text>
            </TouchableOpacity>
          ) : null}
          {/* P0-6：手写规则入口。规则本来只有两个来源——确认弹框（只能生成 allow）与
              hooks.json 的 before_shell（只能 deny）——所以「git push 必须先问」这类
              例外根本表达不出来。这里补上三态（含 ask）的手写入口。 */}
          <Text style={styles.permissionAddTitle}>{t('workspace.settings.permissions.add.title')}</Text>
          <Text style={styles.bodyHint}>{t('workspace.settings.permissions.add.hint')}</Text>
          <View style={styles.chipWrap}>
            {PERMISSION_EFFECTS.map(effect => (
              <Chip
                key={effect}
                label={t(`workspace.settings.permissions.add.effect.${effect}`)}
                active={ruleEffect === effect}
                onPress={() => setRuleEffect(effect)}
                styles={styles}
              />
            ))}
          </View>
          <TextInput
            style={styles.sheetInput}
            value={ruleTool}
            onChangeText={setRuleTool}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('workspace.settings.permissions.add.toolPlaceholder')}
            placeholderTextColor={theme.colors.textFaint}
          />
          <TextInput
            style={styles.sheetInput}
            value={ruleMatch}
            onChangeText={setRuleMatch}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('workspace.settings.permissions.add.matchPlaceholder')}
            placeholderTextColor={theme.colors.textFaint}
          />
          <TouchableOpacity
            style={[styles.permissionAdd, !ruleDraft && styles.permissionAddDisabled]}
            onPress={submitRule}
            disabled={!ruleDraft}
            activeOpacity={0.8}
          >
            <Ionicons name="add" size={15} color={theme.colors.primary} />
            <Text style={styles.permissionAddText}>{t('workspace.settings.permissions.add.submit')}</Text>
          </TouchableOpacity>
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
      // E4：会话事件流导出（旁路审计线索——消息/工具调用事实，事后排查用）。
      id: 'events',
      icon: 'pulse-outline',
      label: t('workspace.settings.events'),
      hint: t('workspace.settings.events.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onExportSessionEvents) onExportSessionEvents();
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
  // 「清除全部授权」：危险动作给危险色 + 描边，但不填满（防误点视觉权重过大）。
  permissionClear: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.danger,
  },
  permissionClearText: {
    marginLeft: 6,
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
  },
  // P0-6：手写规则的输入区（工具名 / 匹配内容）。
  permissionAddTitle: {
    marginTop: 14,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '600',
  },
  // 手写规则 / 保留口径共用的输入框（两处都是「草稿 → 宿主落盘」）。
  sheetInput: {
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  retentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  retentionLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  retentionRange: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(10),
  },
  permissionAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  permissionAddDisabled: {
    opacity: 0.4,
  },
  permissionAddText: {
    marginLeft: 6,
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
  },
  // 「安装示例技能」：中性动作（主题色描边），与上面那个危险色的清除按钮区分开。
  skillsInstall: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  skillsInstallText: {
    marginLeft: 6,
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
  },
  // 工作区模板行：左信息右按钮（每行一个模板，各带「创建」）。
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  templateInfo: {
    flex: 1,
    marginRight: 10,
  },
  templateName: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
  },
  templateDescription: {
    marginTop: 2,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(15),
  },
  templateCreate: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  templateCreateText: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
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
