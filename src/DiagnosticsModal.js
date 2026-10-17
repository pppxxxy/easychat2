import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';

import { clearDiagnostics, formatDiagnostics, getDiagnostics } from './storage/diagnostics.js';
import {
  clearPerfSamples,
  getPerfSamples,
  setPerfProbeEnabled,
  summarizePerfSamples,
} from './logging/perfProbe.js';
import { getPerfProbeEnabled, savePerfProbeEnabled } from './storage/settings/perfProbe.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

// 本地诊断日志查看器：只读展示本机留存的异常记录（已脱敏），支持复制/清空。
// 全程不联网上报，符合 SECURITY.md「未接入分析/遥测 SDK」的承诺。
//
// 卡顿取证开关（2026-10-17 加）就放在这里，而不是设置页：它是**排查工具**，不是
// 用户设置。流程是「开着 → 复现卡顿 → 回来看样本」，入口必须在诊断面板里，
// 一步到位；放进设置页会让用户在两处之间来回找。开关本身持久化
// （storage/settings/perfProbe.js），重启后仍生效。
export default function DiagnosticsModal({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // 「读失败」必须与「确实没有记录」分开：getDiagnostics 读不出来时**抛错**（见
  // storage/diagnostics.js 的 readCache），若和空列表合并成一个状态，绿勾 +
  // diagnostics.empty「暂无可查看的记录」会把「读不出来」说成「一切正常」。
  const [readFailed, setReadFailed] = useState(false);
  // 卡顿取证：开关状态 + 样本。样本只在内存里，所以打开面板时读一次、并提供手动刷新
  // （用户不想关掉面板再打开，就点「刷新样本」）。
  const [perfEnabled, setPerfEnabled] = useState(false);
  const [perfSamples, setPerfSamples] = useState([]);
  const perfSummary = useMemo(() => summarizePerfSamples(perfSamples), [perfSamples]);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoaded(false);
    setReadFailed(false);
    getDiagnostics()
      .then(list => {
        if (!cancelled) {
          setEntries(list);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadFailed(true);
          setLoaded(true);
        }
      });
    // 样本快照：面板一打开就反映当前进度，不用等下一次事件。
    setPerfSamples(getPerfSamples());
    // 开关以**盘上**为准：这里只读、不写。读失败（或键坏）时 getPerfProbeEnabled 已按
    // 「关闭」处理并留了诊断，界面据此显示关闭态，与探针实际状态一致。
    getPerfProbeEnabled()
      .then(stored => {
        if (cancelled) return;
        setPerfEnabled(stored === true);
        // 盘上是开的但本进程还没开（例如启动同步尚未跑完）：补一次同步，避免
        // 「界面显示已开启、探针却没在记」这种最误导人的状态。
        if (stored === true) setPerfProbeEnabled(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const refreshPerfSamples = useCallback(() => {
    setPerfSamples(getPerfSamples());
  }, []);

  const clearPerf = useCallback(() => {
    clearPerfSamples();
    setPerfSamples([]);
  }, []);

  const togglePerf = useCallback(next => {
    const value = next === true;
    // 先同步内存态（探针立即生效），再落盘。落盘失败必须**还原**：否则界面显示已开启、
    // 重启后却是关闭，用户会以为「复现出来了但一条样本都没有」是没卡顿。
    setPerfProbeEnabled(value);
    setPerfEnabled(value);
    savePerfProbeEnabled(value).catch(() => {
      setPerfProbeEnabled(!value);
      setPerfEnabled(!value);
      Alert.alert(t('diagnostics.perf.saveFailed.title'), t('diagnostics.perf.saveFailed.body'));
    });
  }, [t]);

  const text = useMemo(() => formatDiagnostics(entries), [entries]);

  const copyAll = useCallback(async () => {
    if (!text) return;
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert(t('diagnostics.alert.copied.title'), t('diagnostics.alert.copied.body'));
    } catch (error) {
      Alert.alert(t('diagnostics.alert.copyFailed.title'), t('diagnostics.alert.copyFailed.body'));
    }
  }, [text, t]);

  const confirmClear = useCallback(() => {
    Alert.alert(t('diagnostics.alert.clear.title'), t('diagnostics.alert.clear.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('diagnostics.alert.clear.confirm'),
        style: 'destructive',
        onPress: () => {
          // 只有**真的删掉**才把列表清空：clearDiagnostics 现在会把 removeItem 的失败抛出来
          //（旧实现吞掉 ⇒ 这里原来那个 .catch(() => {}) 是死代码，UI 先清空、重启后日志复活）。
          clearDiagnostics()
            .then(() => setEntries([]))
            .catch(() => Alert.alert(t('diagnostics.alert.clearFailed.title'), t('diagnostics.alert.clearFailed.body')));
        },
      },
    ]);
  }, [t]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('diagnostics.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('diagnostics.closeA11y')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {t('diagnostics.hint')}
          </Text>
          <View style={styles.perfCard}>
            <View style={styles.perfRow}>
              <View style={styles.perfLabelWrap}>
                <Text style={styles.perfTitle}>{t('diagnostics.perf.title')}</Text>
                <Text style={styles.perfHint}>{t('diagnostics.perf.hint')}</Text>
              </View>
              <Switch
                value={perfEnabled}
                onValueChange={togglePerf}
                accessibilityLabel={t('diagnostics.perf.switchA11y')}
              />
            </View>
            <Text style={styles.perfCount}>
              {perfSummary.count === 0
                ? t('diagnostics.perf.empty')
                : t('diagnostics.perf.count', { count: perfSummary.count })}
            </Text>
            {perfSummary.worst ? (
              <Text style={styles.perfWorst}>
                {t('diagnostics.perf.worst', {
                  label: perfSummary.worst.label,
                  ms: Math.round(perfSummary.worst.ms),
                })}
              </Text>
            ) : null}
            <View style={styles.perfActions}>
              <TouchableOpacity
                style={[styles.perfButton, styles.ghost]}
                onPress={refreshPerfSamples}
                activeOpacity={0.8}
              >
                <Text style={styles.perfButtonText}>{t('diagnostics.perf.refresh')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.perfButton, styles.ghost, perfSummary.count === 0 && styles.disabled]}
                onPress={clearPerf}
                activeOpacity={0.8}
                disabled={perfSummary.count === 0}
              >
                <Text style={[styles.perfButtonText, perfSummary.count === 0 && styles.disabledText]}>
                  {t('diagnostics.perf.clearSamples')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          {loaded && readFailed ? (
            <View style={styles.empty}>
              <Ionicons name="alert-circle-outline" size={28} color={theme.colors.danger} />
              <Text style={styles.emptyText}>{t('diagnostics.readFailed')}</Text>
            </View>
          ) : loaded && entries.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={28} color={theme.colors.primaryMuted} />
              <Text style={styles.emptyText}>{t('diagnostics.empty')}</Text>
            </View>
          ) : (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <Text style={styles.logText} selectable>{text}</Text>
            </ScrollView>
          )}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.ghost]}
              onPress={confirmClear}
              activeOpacity={0.8}
              disabled={entries.length === 0}
            >
              <Text style={[styles.selectButtonText, entries.length === 0 && styles.disabledText]}>{t('diagnostics.clear')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, entries.length === 0 && styles.disabled]}
              onPress={copyAll}
              activeOpacity={0.8}
              disabled={entries.length === 0}
            >
              <Text style={styles.selectButtonText}>{t('diagnostics.copyAll')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
    maxHeight: '82%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  body: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  bodyContent: { padding: 12 },
  logText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16) },
  perfCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginBottom: 10,
  },
  perfRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  perfLabelWrap: { flex: 1, paddingRight: 12 },
  perfTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  perfHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 2 },
  perfCount: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 8 },
  perfWorst: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  perfActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  perfButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  perfButtonText: { color: theme.colors.text, fontSize: fonts.scaled(12), fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: 28 },
  emptyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  selectButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  selectButtonText: { color: theme.colors.primaryContrast, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  disabledText: { opacity: 0.45 },
});
