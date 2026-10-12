// 插件面板（PluginPanel）——差距 #2「插件化运行时」的用户界面。
//
// 三件事：① 列出已安装插件（可卸载）；② 内置市场（一键安装）；③ 演示「可注册 UI」——
// 把已安装插件贡献的 `settings.row` 槽位渲染出来（PluginSlot）。
//
// 自包含：进来自己读工作区设置、建沙盒 store、加载插件运行时（与工作区面板同款 bootstrapping）。
// 插件落盘 `.easychat/plugins.json`；沙盒执行见 plugins/sandbox.js（能力受限，诚实边界见其文件头）。
//
// 说明：RN UI 文件，已登记进 .c8rc.json 排除。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { createWorkspaceStore } from '../workspace/native.js';
import {
  loadPluginRuntime,
  installPlugin,
  uninstallPlugin,
  listMarket,
  groupPluginsByCategory,
} from '../workspace/plugins/index.js';
import PluginSlot, { UNWIRED_SLOT_KINDS } from '../workspace/screen/PluginSlot.js';
import ExtensionImportSheet from './ExtensionImportSheet.js';

// 归类文案：写成显式映射而不是拼 `workspace.plugins.category.${id}`——模板串拼出来的
// key 静态扫不到，i18n 对账测试既查不出缺键也查不出死键。
const CATEGORY_KEYS = {
  workspace: 'workspace.plugins.category.workspace',
  chat: 'workspace.plugins.category.chat',
  feature: 'workspace.plugins.category.feature',
  other: 'workspace.plugins.category.other',
};

export default function WorkspacePluginsPanel() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [store, setStore] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const mountedRef = React.useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async activeStore => {
    if (!activeStore) return;
    const capabilities = {
      read: path => activeStore.readWorkspaceFile({ path }),
      write: (path, content) => activeStore.writeWorkspaceFile({ path, content }),
    };
    const next = await loadPluginRuntime({ store: activeStore, capabilities });
    if (mountedRef.current) setRuntime(next);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        const created = createWorkspaceStore(settings);
        if (!alive) return;
        setStore(created);
        await reload(created);
      } catch (error) {
        if (alive) setRuntime(null);
      }
    })();
    return () => { alive = false; };
  }, [reload]);

  const installed = (runtime && runtime.plugins) || [];
  const installedIds = new Set(installed.map(item => item.id));

  const handleInstall = useCallback(async item => {
    if (busy || !store) return;
    setBusy(true);
    try {
      const result = await installPlugin({ store, manifest: item.manifest });
      if (!result.ok) {
        Alert.alert(t('workspace.plugins.installFailTitle'), String(result.error || ''));
        return;
      }
      await reload(store);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, store, reload, t]);

  const handleUninstall = useCallback(async plugin => {
    if (busy || !store) return;
    setBusy(true);
    try {
      const result = await uninstallPlugin({ store, id: plugin.id });
      if (!result.ok) {
        Alert.alert(t('workspace.plugins.uninstallFailTitle'), String(result.error || ''));
        return;
      }
      await reload(store);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, store, reload, t]);

  const market = listMarket();
  // 槽位渲染：接线的 kind 正常画（settings.row = 槽位演示区）；**未接线的 kind 也要如实列出**
  // ——注册成功、校验通过却在任何界面都不出现，才是真正的假接线（此前 chat.header 等 5 种
  // 就是这个状态）。未接线行用 kind 当分组标题（技术标识，故意不翻译，不是给终端用户看的
  // 文案），等真实界面接上后把 PluginSlot.js 的 SLOT_RENDER_POINTS 改成渲染点即可。
  const wiredRows = runtime && runtime.registry ? runtime.registry.render('settings.row') : [];
  const unwiredGroups = runtime && runtime.registry
    ? UNWIRED_SLOT_KINDS
      .map(kind => ({ kind, contributions: runtime.registry.render(kind) }))
      .filter(item => item.contributions.length > 0)
    : [];
  const hasSlots = wiredRows.length > 0 || unwiredGroups.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('workspace.plugins.title')}</Text>
        <TouchableOpacity
          style={styles.back}
          onPress={() => setImportOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('workspace.import.open')}
        >
          <Ionicons name="download-outline" size={20} color={theme.colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.hint}>{t('workspace.plugins.hint')}</Text>

        <TouchableOpacity
          style={styles.importRow}
          onPress={() => setImportOpen(true)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('workspace.import.open')}
        >
          <Ionicons name="cloud-download-outline" size={17} color={theme.colors.primary} />
          <View style={styles.importText}>
            <Text style={styles.importTitle}>{t('workspace.import.open')}</Text>
            <Text style={styles.importDesc}>{t('workspace.import.openHint')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
        </TouchableOpacity>

        <Text style={styles.section}>{t('workspace.plugins.installed')}</Text>
        {installed.length === 0 ? (
          <Text style={styles.empty}>{t('workspace.plugins.none')}</Text>
        ) : groupPluginsByCategory(installed).map(group => (
          <View key={group.category}>
            <Text style={styles.groupLabel}>
              {t(CATEGORY_KEYS[group.category])} · {group.items.length}
            </Text>
            {group.items.map(plugin => (
              <View key={plugin.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{plugin.name || plugin.id}</Text>
                  <TouchableOpacity onPress={() => handleUninstall(plugin)} disabled={busy} hitSlop={6}>
                    <Text style={styles.remove}>{t('workspace.plugins.uninstall')}</Text>
                  </TouchableOpacity>
                </View>
                {plugin.description ? <Text style={styles.cardDesc}>{plugin.description}</Text> : null}
                <Text style={styles.cardMeta}>
                  {t('workspace.plugins.meta', { slots: plugin.slots.length, tools: plugin.tools.length })}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {hasSlots ? (
          <>
            <Text style={styles.section}>{t('workspace.plugins.slotDemo')}</Text>
            {wiredRows.length > 0
              ? <PluginSlot kind="settings.row" contributions={wiredRows} />
              : null}
            {unwiredGroups.map(group => (
              <View key={group.kind}>
                {/* 未接线槽位：kind 是技术标识，故意不翻译——它标的是「这里还没落点」，
                    不是给终端用户读的界面文案。 */}
                <Text style={styles.slotKind}>{group.kind}</Text>
                <PluginSlot kind={group.kind} contributions={group.contributions} />
              </View>
            ))}
          </>
        ) : null}

        <Text style={styles.section}>{t('workspace.plugins.market')}</Text>
        {groupPluginsByCategory(market).map(group => (
          <View key={group.category}>
            <Text style={styles.groupLabel}>
              {t(CATEGORY_KEYS[group.category])} · {group.items.length}
            </Text>
            {group.items.map(item => {
              const isInstalled = installedIds.has(item.id);
              return (
                <View key={item.id} style={styles.card}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                    <TouchableOpacity
                      onPress={() => handleInstall(item)}
                      disabled={busy || isInstalled}
                      hitSlop={6}
                    >
                      <Text style={[styles.install, isInstalled && styles.installDone]}>
                        {isInstalled ? t('workspace.plugins.installedTag') : t('workspace.plugins.install')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.cardDesc}>{item.description}</Text>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>

      <ExtensionImportSheet
        visible={importOpen}
        store={store}
        onClose={() => setImportOpen(false)}
        onImported={activeStore => reload(activeStore)}
      />
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 44, paddingHorizontal: 12, paddingBottom: 8,
    borderBottomWidth: tokens.border.thin, borderBottomColor: theme.colors.divider,
  },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  body: { padding: 14, gap: 10 },
  hint: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  importRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
  },
  importText: { flex: 1, marginLeft: 10, marginRight: 8 },
  importTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  importDesc: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), marginTop: 2, lineHeight: fonts.scaled(16) },
  section: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 8 },
  groupLabel: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11.5),
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  // 未接线槽位的分组标题：用技术标识（kind）而不是词条，样式上刻意弱于真正的分区标题。
  slotKind: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), fontWeight: '700', marginTop: 4 },
  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  card: {
    padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin, borderColor: theme.colors.surfaceBorder,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  cardDesc: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 4, lineHeight: fonts.scaled(17) },
  cardMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6 },
  install: { color: theme.colors.primary, fontSize: fonts.scaled(12.5), fontWeight: '600' },
  installDone: { color: theme.colors.textFaint },
  remove: { color: theme.colors.danger || theme.colors.primary, fontSize: fonts.scaled(12.5) },
});
