// 聊天页「总结」入口的设置面板：既能触发一次总结，也能改记忆总结的相关设置。
//
// 口径（用户指定）：
//   - 记忆总结**开启**：保持原状——发送记忆总结内容 + 当前全部历史对话，记忆长度不生效，
//     所以那一行在开启态隐藏，只留一条说明（免得用户以为改了没用）。
//   - 记忆总结**关闭**：没有摘要兜底，改为只发送最近「记忆长度」轮聊天记录（默认 30）。
//     裁剪口径在 chat/replyFlow.js 的 planHistoryWindow，发送链路只调用一次。
//
// 写入走 patchMemorySummarySettings 而不是整体写：设置页的角色预设面板也在编辑同一份
// 设置（它只编辑开关与阈值），整体写会把对方编辑的字段归一回默认值。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  DEFAULT_MEMORY_LENGTH,
  MEMORY_LENGTH_MAX,
  getMemorySummarySettings,
  patchMemorySummarySettings,
} from '../storage/settings.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

// 与存储层同口径的整数解析：非法/非正数回落到 fallback，超过上限截断。
function normalizeInt(raw, fallback, max = 0) {
  const parsed = Math.trunc(Number(String(raw).trim()));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max > 0 ? Math.min(parsed, max) : parsed;
}

export default function MemorySummarySheet({
  visible,
  onClose,
  onSummarize,
  summarizing = false,
  canSummarize = true,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState('');
  const [length, setLength] = useState(String(DEFAULT_MEMORY_LENGTH));

  // 每次打开都重新读：设置页那边也可能刚改过，草稿不能跨次复用。
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoaded(false);
    getMemorySummarySettings()
      .then(settings => {
        if (cancelled) return;
        setSaved(settings);
        setEnabled(settings.enabled);
        setThreshold(String(settings.threshold));
        setLength(String(settings.historyRounds));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert(t('preset.alert.loadFailed.title'), t('preset.alert.loadFailed.body'));
      });
    return () => { cancelled = true; };
  }, [visible, t]);

  const persist = useCallback(async () => {
    if (!saved) return false;
    const nextThreshold = normalizeInt(threshold, saved.threshold);
    const nextLength = normalizeInt(length, saved.historyRounds, MEMORY_LENGTH_MAX);
    if (nextThreshold !== Math.trunc(Number(String(threshold).trim()))) {
      Alert.alert(
        t('preset.alert.thresholdInvalid.title'),
        t('preset.alert.thresholdInvalid.body', { fallback: nextThreshold })
      );
    }
    if (nextLength !== Math.trunc(Number(String(length).trim()))) {
      Alert.alert(
        t('chat.summary.settings.lengthInvalid.title'),
        t('chat.summary.settings.lengthInvalid.body', { max: MEMORY_LENGTH_MAX, fallback: nextLength })
      );
    }
    setBusy(true);
    try {
      const next = await patchMemorySummarySettings({
        enabled,
        threshold: nextThreshold,
        historyRounds: nextLength,
      });
      setSaved(next);
      setEnabled(next.enabled);
      setThreshold(String(next.threshold));
      setLength(String(next.historyRounds));
      return true;
    } catch (error) {
      Alert.alert(t('preset.alert.saveFailed.title'), t('preset.alert.saveFailed.body'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [saved, enabled, threshold, length, t]);

  const handleSave = useCallback(async () => {
    if (!loaded || busy) return;
    if (await persist()) onClose();
  }, [loaded, busy, persist, onClose]);

  // 开始总结前先把草稿落地：面板里看到的值就是这次总结要用的值。
  const handleSummarize = useCallback(async () => {
    if (!loaded || busy || summarizing || !canSummarize) return;
    if (!(await persist())) return;
    onClose();
    if (typeof onSummarize === 'function') onSummarize();
  }, [loaded, busy, summarizing, canSummarize, persist, onClose, onSummarize]);

  const roundHint = normalizeInt(
    length,
    saved ? saved.historyRounds : DEFAULT_MEMORY_LENGTH,
    MEMORY_LENGTH_MAX
  );
  const actionsDisabled = !loaded || busy;
  const runDisabled = actionsDisabled || summarizing || !canSummarize;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.modalSheet, styles.sheetWidth]} accessibilityViewIsModal importantForAccessibility="yes">
          <Text style={styles.modalTitle}>{t('chat.summary.settings.title')}</Text>
          <Text style={styles.compactFocusHint}>{t('preset.memory.desc')}</Text>

          <View style={styles.localRow}>
            <Text style={styles.chatSettingsText}>{t('preset.memory.title')}</Text>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
              disabled={actionsDisabled}
            />
          </View>

          <Text style={styles.modelLabel}>{t('preset.memory.thresholdLabel')}</Text>
          <TextInput
            style={styles.stickerNameInput}
            value={threshold}
            onChangeText={setThreshold}
            editable={!actionsDisabled}
            keyboardType="number-pad"
            placeholder={saved ? String(saved.threshold) : ''}
            placeholderTextColor={theme.colors.textFaint}
          />

          {enabled ? (
            <Text style={styles.chatSettingsHint}>{t('chat.summary.settings.lengthDisabled')}</Text>
          ) : (
            <>
              <Text style={styles.modelLabel}>{t('chat.summary.settings.lengthLabel')}</Text>
              <TextInput
                style={styles.stickerNameInput}
                value={length}
                onChangeText={setLength}
                editable={!actionsDisabled}
                keyboardType="number-pad"
                placeholder={String(DEFAULT_MEMORY_LENGTH)}
                placeholderTextColor={theme.colors.textFaint}
              />
              <Text style={styles.chatSettingsHint}>
                {t('chat.summary.settings.lengthHint', { rounds: roundHint })}
              </Text>
            </>
          )}

          <View style={styles.stickerNameActions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('common.close')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, actionsDisabled && styles.sendButtonDisabled]}
              onPress={handleSave}
              disabled={actionsDisabled}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>

          {/* 单独一行：与上面两个设置按钮区分开（它是「顺手总结一次」，不是保存）。 */}
          <TouchableOpacity
            style={[
              styles.selectButton,
              { marginLeft: 0, marginTop: tokens.spacing.md, alignItems: 'center' },
              runDisabled && styles.sendButtonDisabled,
            ]}
            onPress={handleSummarize}
            disabled={runDisabled}
            activeOpacity={0.8}
          >
            <Text style={styles.selectButtonText}>
              {summarizing ? t('chat.menu.summarizing') : t('chat.summary.confirm.action')}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
