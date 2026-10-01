// 本地模型运行日志弹窗：展示内存环形缓冲（加载/推理/服务事件），可清空。
// 日志本身由 src/localModel/modelLogs.js 维护，本组件只做展示。

import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { clearModelLogs, getModelLogs } from './modelLogs.js';
import { useTheme } from '../theme/ThemeContext.js';

function formatTime(at) {
  const date = new Date(Number(at) || Date.now());
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function ModelLogsModal({ visible, onClose }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    if (!visible) return;
    setLogs(getModelLogs());
  }, [visible]);

  const refresh = () => setLogs(getModelLogs());
  const clear = () => {
    clearModelLogs();
    setLogs([]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>本地模型日志</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={styles.toolbar}>
            <TouchableOpacity onPress={refresh} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="刷新">
              <Text style={styles.toolbarText}>刷新</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={clear} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="清空">
              <Text style={styles.dangerText}>清空</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {logs.length === 0 ? (
              <Text style={styles.empty}>暂无日志。加载或使用本地模型后会在这里记录。</Text>
            ) : (
              logs.slice().reverse().map((entry, index) => (
                <View key={`${entry.at}-${index}`} style={styles.row}>
                  <Text style={styles.rowMeta}>
                    {formatTime(entry.at)} · {entry.event}
                  </Text>
                  <Text style={[styles.rowMessage, entry.level === 'error' && styles.rowMessageError, entry.level === 'warn' && styles.rowMessageWarn]}>
                    {entry.message}
                  </Text>
                  {entry.context ? <Text style={styles.rowContext} numberOfLines={2}>{entry.context}</Text> : null}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '88%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  toolbar: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  toolbarText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700', marginRight: 18 },
  dangerText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  content: { paddingBottom: 18 },
  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), textAlign: 'center', marginTop: 20 },
  row: { borderBottomWidth: 1, borderBottomColor: theme.colors.surfaceBorder, paddingVertical: 8 },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  rowMessage: { color: theme.colors.text, fontSize: fonts.scaled(13), marginTop: 2 },
  rowMessageWarn: { color: theme.colors.dangerSoft },
  rowMessageError: { color: theme.colors.danger },
  rowContext: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
});
