import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export default function AboutSection(props) {
  const {
    styles,
    theme,
    appVersion,
    checkUpdate,
    openDisclaimer,
    openGitHub,
    openTutorial,
    setBackupOpen,
    setDiagnosticsOpen,
    setLocalModelOpen,
  } = props;
  return (
    <>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pricetag-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>当前版本</Text>
            </View>
            <Text style={styles.versionText}>{appVersion || '未知'}</Text>
          </View>
          <TouchableOpacity style={styles.linkRow} onPress={openTutorial} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="book-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>使用教程</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openDisclaimer} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="document-text-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>免责条款</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openGitHub} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="logo-github" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>GitHub 地址</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={checkUpdate} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="refresh-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>检测更新</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setDiagnosticsOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="bug-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>诊断日志</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setBackupOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="archive-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>备份与恢复</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setLocalModelOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="hardware-chip-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>本地模型</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
    </>
  );
}
