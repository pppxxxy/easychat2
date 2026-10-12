import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';

import { clearDiagnostics, formatDiagnostics, getDiagnostics } from './storage/diagnostics.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

// 本地诊断日志查看器：只读展示本机留存的异常记录（已脱敏），支持复制/清空。
// 全程不联网上报，符合 SECURITY.md「未接入分析/遥测 SDK」的承诺。
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
    return () => {
      cancelled = true;
    };
  }, [visible]);

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
