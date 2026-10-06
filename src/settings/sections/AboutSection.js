import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export default function AboutSection(props) {
  const {
    styles,
    theme,
    t,
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
              <Text style={styles.linkText}>{t('settings.about.version')}</Text>
            </View>
            <Text style={styles.versionText}>{appVersion || t('settings.about.versionUnknown')}</Text>
          </View>
          <TouchableOpacity style={styles.linkRow} onPress={openTutorial} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="book-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.about.tutorial')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openDisclaimer} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="document-text-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.about.disclaimer')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={openGitHub} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="logo-github" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.about.github')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkRow} onPress={checkUpdate} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="refresh-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.about.checkUpdate')}</Text>
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
              <Text style={styles.linkText}>{t('settings.about.diagnostics')}</Text>
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
              <Text style={styles.linkText}>{t('settings.about.backup')}</Text>
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
              <Text style={styles.linkText}>{t('settings.about.localModel')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
    </>
  );
}
