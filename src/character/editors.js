// 角色页的模块级展示/编辑子组件。从 src/CharacterScreen.js 原样外提（无行为变化）。
// 只依赖 props、theme 与 cardHelpers/regexEngine/lorebook 的纯函数。

import React, { useEffect, useMemo, useState } from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { TextField } from '../ui/index.js';
import { REGEX_PLACEMENT_LABELS, WORLD_POSITION_LABELS } from './cardParser.js';
import { isUnsafeRegexPattern } from '../prompt/regexEngine.js';
import { getUnsafeWorldEntryKeys } from '../prompt/lorebook.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createCharacterStyles } from './characterStyles.js';
import { splitKeywords, placementText } from './cardHelpers.js';

const WORLD_POSITION_KEYS = Object.keys(WORLD_POSITION_LABELS)
  .map(Number)
  .sort((a, b) => a - b);
const REGEX_PLACEMENT_KEYS = [1, 2, 3, 5, 6];
const WORLD_ROLES = ['system', 'user', 'assistant'];

const createStyles = createCharacterStyles;

export function DataField({ label, value }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  if (!value) return null;
  return (
    <View style={styles.dataField}>
      <Text style={styles.dataFieldLabel}>{label}</Text>
      <Text style={styles.dataFieldValue} numberOfLines={6}>{value}</Text>
    </View>
  );
}

export function ToggleRow({ label, value, onValueChange }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
        thumbColor={theme.colors.primaryContrast}
      />
    </View>
  );
}

export function Chip({ label, active, onPress }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
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

export function NumberField({ label, value, onCommit }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => {
    setText(String(value ?? ''));
  }, [value]);
  const commit = () => {
    const parsed = parseInt(String(text).replace(/[^0-9-]/g, ''), 10);
    if (Number.isFinite(parsed)) {
      setText(String(parsed));
      onCommit(parsed);
    } else {
      setText(String(value ?? ''));
    }
  };
  return (
    <View style={styles.numberField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextField
        style={styles.inputSmall}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onEndEditing={commit}
        keyboardType="number-pad"
        placeholder={label}
      />
    </View>
  );
}

export function CollapsibleSection({ title, count, expanded, onToggle, onAdd, addLabel, icon, children }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={styles.sectionCard}>
      <TouchableOpacity style={styles.sectionHeader} onPress={onToggle} activeOpacity={0.8}>
        <View style={styles.sectionTitleRow}>
          {icon ? <Ionicons name={icon} size={15} color={theme.colors.primaryMuted} /> : null}
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.primaryMuted} />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.sectionBody}>
          {children}
          {onAdd ? (
            <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.addButtonText}>{addLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function WorldEntryEditor({ entry, index, onChange, onRemove }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  const unsafeKeys = getUnsafeWorldEntryKeys(entry);
  const position = WORLD_POSITION_LABELS[entry.position] ? entry.position : 0;
  const cyclePosition = () => {
    const current = WORLD_POSITION_KEYS.indexOf(position);
    const next = WORLD_POSITION_KEYS[(current + 1) % WORLD_POSITION_KEYS.length];
    onChange({ position: next, positionLabel: WORLD_POSITION_LABELS[next] });
  };
  const cycleRole = () => {
    const current = WORLD_ROLES.indexOf(entry.role);
    const next = WORLD_ROLES[(current + 1) % WORLD_ROLES.length];
    onChange({ role: next });
  };
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {entry.comment || `条目 ${index + 1}`}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>删除</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>名称</Text>
      <TextField
        style={styles.inputSmall}
        value={entry.comment}
        onChangeText={comment => onChange({ comment })}
        placeholder="世界书条目名称"
      />
      <Text style={styles.fieldLabel}>触发关键词（逗号分隔）</Text>
      <TextField
        style={styles.inputSmall}
        value={keys.join(', ')}
        onChangeText={text => onChange({ keys: splitKeywords(text) })}
        placeholder="关键词一, 关键词二"
      />
      {unsafeKeys.length > 0 ? (
        <Text style={styles.regexUnsafeHint}>
          {`以下关键词存在嵌套无界量词，疑似灾难性回溯，运行时会跳过：${unsafeKeys.join('、')}`}
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>内容</Text>
      <TextField
        style={styles.contentInput}
        value={entry.content}
        onChangeText={content => onChange({ content })}
        placeholder="命中后注入提示词的内容"
        multiline
        textAlignVertical="top"
      />
      <ToggleRow
        label="常驻（无需关键词）"
        value={entry.constant}
        onValueChange={constant => onChange({ constant })}
      />
      <ToggleRow
        label="启用"
        value={entry.enabled}
        onValueChange={enabled => onChange({ enabled })}
      />
      <View style={styles.cycleRow}>
        <TouchableOpacity style={styles.cycleButton} onPress={cyclePosition} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>位置：{WORLD_POSITION_LABELS[position]}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cycleButton} onPress={cycleRole} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>角色：{entry.role}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.numberRow}>
        <NumberField
          label="顺序"
          value={entry.order ?? 100}
          onCommit={order => onChange({ order })}
        />
        {position === 4 ? (
          <NumberField
            label="深度"
            value={entry.depth ?? 4}
            onCommit={depth => onChange({ depth })}
          />
        ) : null}
      </View>
    </View>
  );
}

export function RegexEntryEditor({ script, index, onChange, onRemove }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const placement = Array.isArray(script.placement) ? script.placement : [1, 2];
  const togglePlacement = value => {
    const has = placement.includes(value);
    const next = has
      ? placement.filter(item => item !== value)
      : [...placement, value].sort((a, b) => a - b);
    onChange({ placement: next, placementLabel: placementText(next) });
  };
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {script.name || `正则 ${index + 1}`}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>删除</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>名称</Text>
      <TextField
        style={styles.inputSmall}
        value={script.name}
        onChangeText={name => onChange({ name })}
        placeholder="正则脚本名称"
      />
      <Text style={styles.fieldLabel}>匹配表达式</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.findRegex}
        onChangeText={findRegex => onChange({ findRegex })}
        placeholder={'例如：\\bfoo\\b'}
        multiline
        textAlignVertical="top"
      />
      {isUnsafeRegexPattern(script.findRegex) ? (
        <Text style={styles.regexUnsafeHint}>
          该表达式存在嵌套无界量词，疑似灾难性回溯；为避免卡死界面，运行时会跳过此脚本。
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>替换为</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.replaceString}
        onChangeText={replaceString => onChange({ replaceString })}
        placeholder="替换后的文本，可留空表示删除"
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.fieldLabel}>flags</Text>
      <TextField
        style={[styles.inputSmall, styles.codeInput]}
        value={script.flags}
        onChangeText={flags => onChange({ flags })}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="g"
      />
      <Text style={styles.dataMeta}>/表达式/flags 使用内嵌 flags；裸表达式的 flags 留空时仅替换首个匹配。</Text>
      <Text style={styles.fieldLabel}>作用范围</Text>
      <View style={styles.chipRow}>
        {REGEX_PLACEMENT_KEYS.map(key => (
          <Chip
            key={key}
            label={REGEX_PLACEMENT_LABELS[key] || `范围 ${key}`}
            active={placement.includes(key)}
            onPress={() => togglePlacement(key)}
          />
        ))}
      </View>
      <Text style={styles.dataMeta}>AI 输出包含开场白与助手历史消息。</Text>
      <ToggleRow label="启用" value={script.enabled} onValueChange={enabled => onChange({ enabled })} />
      <ToggleRow
        label="仅用于界面显示"
        value={script.markdownOnly}
        onValueChange={markdownOnly => onChange({ markdownOnly })}
      />
      <ToggleRow
        label="仅用于发送提示词"
        value={script.promptOnly}
        onValueChange={promptOnly => onChange({ promptOnly })}
      />
    </View>
  );
}

export function SummaryRow({ title, meta, enabled, onPress }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity style={styles.summaryRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.summaryInfo}>
        <Text style={styles.summaryTitle} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={styles.summaryMeta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {enabled === false ? (
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>已停用</Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
    </TouchableOpacity>
  );
}
