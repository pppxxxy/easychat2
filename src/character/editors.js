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
import { useTranslation } from '../i18n/I18nContext.js';
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

export function WorldEntryEditor({ entry, index, onChange, onRemove }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
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
          {entry.comment || t('character.editor.world.entryFallback', { n: index + 1 })}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>{t('character.editor.delete')}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>{t('character.editor.nameLabel')}</Text>
      <TextField
        style={styles.inputSmall}
        value={entry.comment}
        onChangeText={comment => onChange({ comment })}
        placeholder={t('character.editor.world.namePlaceholder')}
      />
      <Text style={styles.fieldLabel}>{t('character.editor.world.keysLabel')}</Text>
      <TextField
        style={styles.inputSmall}
        value={keys.join(', ')}
        onChangeText={text => onChange({ keys: splitKeywords(text) })}
        placeholder={t('character.editor.world.keysPlaceholder')}
      />
      {unsafeKeys.length > 0 ? (
        <Text style={styles.regexUnsafeHint}>
          {t('character.editor.world.unsafeKeys', { keys: unsafeKeys.join('、') })}
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>{t('character.editor.world.contentLabel')}</Text>
      <TextField
        style={styles.contentInput}
        value={entry.content}
        onChangeText={content => onChange({ content })}
        placeholder={t('character.editor.world.contentPlaceholder')}
        multiline
        textAlignVertical="top"
      />
      <ToggleRow
        label={t('character.editor.world.constant')}
        value={entry.constant}
        onValueChange={constant => onChange({ constant })}
      />
      <ToggleRow
        label={t('character.editor.enabled')}
        value={entry.enabled}
        onValueChange={enabled => onChange({ enabled })}
      />
      <View style={styles.cycleRow}>
        <TouchableOpacity style={styles.cycleButton} onPress={cyclePosition} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>{t('character.editor.world.position', { label: WORLD_POSITION_LABELS[position] })}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cycleButton} onPress={cycleRole} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>{t('character.editor.world.role', { role: entry.role })}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.numberRow}>
        <NumberField
          label={t('character.editor.order')}
          value={entry.order ?? 100}
          onCommit={order => onChange({ order })}
        />
        {position === 4 ? (
          <NumberField
            label={t('character.editor.depth')}
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
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const placement = Array.isArray(script.placement) ? script.placement : [1, 2];
  const togglePlacement = value => {
    const has = placement.includes(value);
    const next = has
      ? placement.filter(item => item !== value)
      : [...placement, value].sort((a, b) => a - b);
    onChange({
      placement: next,
      placementLabel: placementText(next, { scopeFallback: t('character.editor.regex.scopeFallback') }),
    });
  };
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {script.name || t('character.editor.regex.entryFallback', { n: index + 1 })}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>{t('character.editor.delete')}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>{t('character.editor.nameLabel')}</Text>
      <TextField
        style={styles.inputSmall}
        value={script.name}
        onChangeText={name => onChange({ name })}
        placeholder={t('character.editor.regex.namePlaceholder')}
      />
      <Text style={styles.fieldLabel}>{t('character.editor.regex.findLabel')}</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.findRegex}
        onChangeText={findRegex => onChange({ findRegex })}
        placeholder={t('character.editor.regex.findPlaceholder')}
        multiline
        textAlignVertical="top"
      />
      {isUnsafeRegexPattern(script.findRegex) ? (
        <Text style={styles.regexUnsafeHint}>
          {t('character.editor.regex.unsafeHint')}
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>{t('character.editor.regex.replaceLabel')}</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.replaceString}
        onChangeText={replaceString => onChange({ replaceString })}
        placeholder={t('character.editor.regex.replacePlaceholder')}
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
      <Text style={styles.dataMeta}>{t('character.editor.regex.flagsHint')}</Text>
      <Text style={styles.fieldLabel}>{t('character.editor.regex.scopeLabel')}</Text>
      <View style={styles.chipRow}>
        {REGEX_PLACEMENT_KEYS.map(key => (
          <Chip
            key={key}
            label={REGEX_PLACEMENT_LABELS[key] || t('character.editor.regex.scopeFallback', { key })}
            active={placement.includes(key)}
            onPress={() => togglePlacement(key)}
          />
        ))}
      </View>
      <Text style={styles.dataMeta}>{t('character.editor.regex.scopeHint')}</Text>
      <ToggleRow label={t('character.editor.enabled')} value={script.enabled} onValueChange={enabled => onChange({ enabled })} />
      <ToggleRow
        label={t('character.editor.regex.markdownOnly')}
        value={script.markdownOnly}
        onValueChange={markdownOnly => onChange({ markdownOnly })}
      />
      <ToggleRow
        label={t('character.editor.regex.promptOnly')}
        value={script.promptOnly}
        onValueChange={promptOnly => onChange({ promptOnly })}
      />
    </View>
  );
}

export function SummaryRow({ title, meta, enabled, onPress }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity style={styles.summaryRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.summaryInfo}>
        <Text style={styles.summaryTitle} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={styles.summaryMeta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {enabled === false ? (
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>{t('character.editor.disabled')}</Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
    </TouchableOpacity>
  );
}
