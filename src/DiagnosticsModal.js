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

import { clearDiagnostics, formatDiagnostics, getDiagnostics } from './diagnostics';
import { useTheme } from './theme/ThemeContext';

// 本地诊断日志查看器：只读展示本机留存的异常记录（已脱敏），支持复制/清空。
// 全程不联网上报，符合 SECURITY.md「未接入分析/遥测 SDK」的承诺。
export default function DiagnosticsModal({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoaded(false);
    getDiagnostics()
      .then(list => {
        if (!cancelled) {
          setEntries(list);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
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
      Alert.alert('已复制', '诊断日志已复制到剪贴板，可直接粘贴反馈。');
    } catch (error) {
      Alert.alert('复制失败', '请手动选择文本复制。');
    }
  }, [text]);

  const confirmClear = useCallback(() => {
    Alert.alert('清空诊断日志', '确定清空本机留存的诊断记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          clearDiagnostics().catch(() => {});
          setEntries([]);
        },
      },
    ]);
  }, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>诊断日志</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            仅保存在本机、已脱敏，不会上传到任何服务器。遇到异常时可复制后反馈。
          </Text>
          {loaded && entries.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={28} color={theme.colors.primaryMuted} />
              <Text style={styles.emptyText}>暂无可查看的记录。</Text>
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
              <Text style={[styles.selectButtonText, entries.length === 0 && styles.disabledText]}>清空</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, entries.length === 0 && styles.disabled]}
              onPress={copyAll}
              activeOpacity={0.8}
              disabled={entries.length === 0}
            >
              <Text style={styles.selectButtonText}>复制全部</Text>
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
