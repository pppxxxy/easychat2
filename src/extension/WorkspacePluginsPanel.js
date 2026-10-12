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
} from '../workspace/plugins/index.js';
// 重置是 loader 的写路径（与 install/uninstall 同一处收口：读失败拒绝写、只重写清单文件），
// 直接从 loader 取，不再经 barrel 多绕一层转发。
import { resetPluginsFile } from '../workspace/plugins/loader.js';
import PluginSlot, { UNWIRED_SLOT_KINDS } from '../workspace/screen/PluginSlot.js';

export default function WorkspacePluginsPanel() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [store, setStore] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [busy, setBusy] = useState(false);
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
  // loader 的 status 是四态（ok / missing / error / corrupt），面板必须**分开**处理后两态：
  //   error   —— 读失败：内容可能完好，只是这次读不到；此时 loader 拒绝写入（避免用空清单
  //              覆盖已有插件），面板要说明「安装/卸载已暂停」并给重试；
  //   corrupt —— 内容损坏：文件在、解析不出来。既不能像 error 那样只让重试（重试永远失败），
  //              也不能自动重置（那等于静默删掉用户已装插件），所以只给一个**显式**的重置入口。
  const runtimeStatus = (runtime && runtime.status) || '';
  const corrupt = runtimeStatus === 'corrupt';
  const readFailed = runtimeStatus === 'error';
  // 这两态下「还没有安装任何插件」是一句我们**证明不了**的话（清单根本没读出来），
  // 不能显示——否则用户以为插件丢了，上面的提示条才是真实情况。
  const installedEmptyText = corrupt || readFailed ? '' : t('workspace.plugins.none');

  const handleInstall = useCallback(async item => {
    if (busy || !store) return;
    setBusy(true);
    try {
      const result = await installPlugin({ store, manifest: item.manifest });
      if (!result.ok) {
        Alert.alert(t('workspace.plugins.installFailTitle'), String(result.error || ''));
        return;
      }
      // 原清单是损坏态时，loader 是**重建**了它（只含本次安装的插件）。必须在安装成功的
      // 这一刻告诉用户旧清单被换掉了——否则又是一次静默丢失（静默丢失正是要消除的东西）。
      if (result.rebuilt) {
        Alert.alert(t('workspace.plugins.corrupt.rebuiltTitle'), t('workspace.plugins.corrupt.rebuiltBody'));
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

  // 「重置插件清单」：**只有用户显式点 + 确认之后**才写。损坏态下我们连装了什么都读不出来，
  // 自动重置等于静默删掉用户已装的插件列表——所以这个动作永远不能自动发生。
  const handleReset = useCallback(() => {
    if (busy || !store) return;
    Alert.alert(
      t('workspace.plugins.corrupt.resetConfirmTitle'),
      t('workspace.plugins.corrupt.resetConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('workspace.plugins.corrupt.resetConfirmAction'),
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const result = await resetPluginsFile({ store });
              if (!result.ok) {
                Alert.alert(t('workspace.plugins.corrupt.resetFailTitle'), String(result.error || ''));
                return;
              }
              await reload(store);
            } finally {
              if (mountedRef.current) setBusy(false);
            }
          },
        },
      ]
    );
  }, [busy, store, reload, t]);

  const market = listMarket();
  // 槽位渲染：接线的 kind 正常画（settings.row = 槽位演示区）；**未接线的 kind 也要如实列出**
  // ——注册成功、校验通过却在任何界面都不出现，才是真正的假接线（此前 chat.header 等 5 种
  // 就是这个状态）。未接线行用 kind 当分组标题（技术标识，故意不翻译，不是给终端用户看的
  // 文案），等真实界面接上后把 PluginSlot.js 的 SLOT_RENDER_POINTS 改成渲染点即可。
  const wiredRows = runtime && runtime.registry ? runtime.registry.render('settings.row') : [];
  const unwiredGroups = runtime && runtime.registry
    ? UNWIRED_SLOT_KINDS
      .map(kind => ({
        kind,
        // registry.render() 对未接线的 kind 会在列表最前面插一条「未接线」标记（wired === false）
        // ——那是给调用方的**状态信号**，不是插件贡献。这里先滤掉它再判「这一组要不要显示」，
        // 否则没装任何插件时也会列出 5 个空分组（hasSlots 永远为真）。
        contributions: runtime.registry.render(kind).filter(item => item.wired !== false),
      }))
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
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.hint}>{t('workspace.plugins.hint')}</Text>

        {/* 内容损坏：文件在、但解析不出 { plugins: [...] }。必须如实告诉用户——否则面板会
            显示「还没有安装任何插件」，用户以为插件丢了，而下一次安装还会静默把旧内容顶掉。
            出路是**显式**重置（带确认框），不是自动重置，也不是拒绝安装。 */}
        {corrupt ? (
          <View style={styles.warnBanner}>
            <Text style={styles.warnText}>{t('workspace.plugins.corrupt')}</Text>
            <TouchableOpacity onPress={handleReset} disabled={busy} hitSlop={6}>
              <Text style={styles.warnAction}>{t('workspace.plugins.corrupt.reset')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* 读失败：与损坏分开——内容可能完好，只是这次读不到（权限 / SAF / 底层 IO）。
            loader 此时拒绝写入，所以安装与卸载都会失败，这里说明原因并给重试。 */}
        {readFailed ? (
          <View style={styles.warnBanner}>
            <Text style={styles.warnText}>{t('workspace.plugins.readFailed')}</Text>
            <TouchableOpacity onPress={() => reload(store)} disabled={busy} hitSlop={6}>
              <Text style={styles.warnAction}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={styles.section}>{t('workspace.plugins.installed')}</Text>
        {installed.length === 0 ? (
          installedEmptyText ? <Text style={styles.empty}>{installedEmptyText}</Text> : null
        ) : installed.map(plugin => (
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
        {market.map(item => {
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
      </ScrollView>
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
  section: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 8 },
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
  // 提示条（清单损坏 / 读失败）：与错误同色系，但**不是**弹框——用户是在面板里看到
  // 「发生了什么 + 能做什么」，而不是被一个必须点掉的对话框拦住。
  warnBanner: {
    padding: 12, borderRadius: 10, gap: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.danger || theme.colors.surfaceBorder,
  },
  warnText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  warnAction: { color: theme.colors.primary, fontSize: fonts.scaled(12.5), fontWeight: '600' },
});
