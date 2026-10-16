import React from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

// 应用内公告（任务书 6）：入口与弹层都**内聚在本组件**里，不再往上加接线。
// 理由：SettingsScreen.js 正处于行数基线的冻结值上（2365/2365，零余量），
// 而「更新说明」只依赖 appVersion 与本地缓存（确实用不到设置页的任何状态）——
// 自持一份 autoResolve:false 的实例（不联网，只读启动路径已写好的缓存）最省、也最内聚。
import AnnouncementModal from '../../announcements/AnnouncementModal.js';
import useAnnouncement from '../../announcements/useAnnouncement.js';

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
  } = props;
  // autoResolve:false —— 进设置页不该顺手发一次 GitHub 请求；缓存由启动路径负责刷新。
  const announcement = useAnnouncement({ localVersion: appVersion, autoResolve: false });
  return (
    <>
          <View style={styles.linkRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pricetag-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.about.version')}</Text>
            </View>
            <Text style={styles.versionText}>{appVersion || t('settings.about.versionUnknown')}</Text>
          </View>
          <TouchableOpacity style={styles.linkRow} onPress={announcement.open} activeOpacity={0.7}>
            <View style={styles.linkLeft}>
              <Ionicons name="megaphone-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('announcement.entry')}</Text>
            </View>
            <Text style={styles.versionText}>
              {announcement.release ? `v${announcement.release.version}` : t('announcement.entryNone')}
            </Text>
          </TouchableOpacity>
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
          <AnnouncementModal
            visible={announcement.visible}
            release={announcement.release}
            onClose={announcement.close}
            onDismissVersion={announcement.dismissVersion}
            onOpenRelease={
              announcement.release && announcement.release.url
                ? () => Linking.openURL(announcement.release.url).catch(() => {})
                : undefined
            }
          />
    </>
  );
}
