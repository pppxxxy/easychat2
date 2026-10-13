// 「导入扩展」弹层——扩展兼容性的用户入口。
//
// 三种来源：GitHub 仓库（可先按关键词搜仓库）、npm 包、直接粘贴配置文本。判定与适配
// 全在 workspace/import/ 里（纯逻辑），这里只负责输入、预览与确认——**先预览再落盘**，
// 因为导入是写操作（插件还能执行代码），得让用户看清这一步会装进来什么。
//
// 弹层而不是独立页面：设置页的工作区卡与「扩展 → 插件」页都要能开它，而设置页宿主
// 文件有行数棘轮（加状态/渲染会顶破基线）。谁需要谁渲染，两边零接线成本。
//
// 说明：RN UI 文件，已登记进 .c8rc.json 排除。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton, SecondaryButton, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { getGithubMcpSettings } from '../storage/githubMcp.js';
import { getMcpServers, saveMcpServers } from '../storage/settings/mcpServers.js';
import { createWorkspaceStore } from '../workspace/native.js';
import { IMPORT_METHODS, previewImport, runImport, findRepos } from '../workspace/import/index.js';

const KIND_KEYS = {
  plugin: 'workspace.import.kind.plugin',
  pack: 'workspace.import.kind.pack',
  skill: 'workspace.import.kind.skill',
  command: 'workspace.import.kind.command',
  agent: 'workspace.import.kind.agent',
  mcpServer: 'workspace.import.kind.mcpServer',
};

const NOTE_KEYS = {
  stdio: 'workspace.import.note.stdio',
  sse: 'workspace.import.note.sse',
  notHttp: 'workspace.import.note.notHttp',
  noEndpoint: 'workspace.import.note.noEndpoint',
  claudePluginBundle: 'workspace.import.note.claudePlugin',
  invalidPack: 'workspace.import.note.invalidPack',
  badName: 'workspace.import.note.badName',
  capped: 'workspace.import.note.capped',
};

// 导入前的安全提示：插件 handler 是会在沙盒里执行的代码，落盘前必须让用户知道。
// 另外如实报「有文件没取到」——GitHub 未带 token 时限流很紧，静默少装比报错更难查。
function previewWarnings(summary, meta, t) {
  const out = [];
  if (summary && summary.plugins > 0) out.push(t('workspace.import.note.pluginWarning'));
  const failed = Number(meta && meta.failed) || 0;
  if (failed > 0) out.push(t('workspace.import.note.partialFetch', { count: failed }));
  return out;
}

export default function ExtensionImportSheet({ visible, onClose, store = null, onImported = null }) {
  const { t } = useTranslation();
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [method, setMethod] = useState('github');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [repos, setRepos] = useState([]);
  const [storeState, setStoreState] = useState(store);
  const [token, setToken] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 每次打开重置：上次的预览与搜索结果不该跟着这次进来
  useEffect(() => {
    if (!visible) return;
    setBusy('');
    setPreview(null);
    setRepos([]);
  }, [visible]);

  useEffect(() => {
    if (!visible || storeState) return;
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        const created = createWorkspaceStore(settings);
        if (alive) setStoreState(created);
      } catch (error) {}
    })();
    return () => { alive = false; };
  }, [visible, storeState]);

  // GitHub token 只在真要打 API 时读：让私有仓库与更高限额可用（公开仓库无 token 也能跑）
  const loadToken = useCallback(async () => {
    if (token) return token;
    try {
      const settings = await getGithubMcpSettings();
      const value = settings && (settings.githubToken || settings.githubAccessToken);
      const resolved = typeof value === 'string' ? value : '';
      if (resolved && mountedRef.current) setToken(resolved);
      return resolved;
    } catch (error) {
      return '';
    }
  }, [token]);

  const onCheck = useCallback(async () => {
    const text = String(input || '').trim();
    if (!text || busy) return;
    setBusy('check');
    setPreview(null);
    try {
      const auth = /github\.com|^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? await loadToken() : '';
      const result = await previewImport({ input: text, token: auth });
      if (mountedRef.current) setPreview(result);
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }, [input, busy, loadToken]);

  const onSearch = useCallback(async () => {
    const query = String(input || '').trim();
    if (!query || busy) return;
    setBusy('search');
    try {
      const auth = await loadToken();
      const found = await findRepos({ query, token: auth });
      if (mountedRef.current) setRepos(found);
    } catch (error) {
      if (mountedRef.current) setRepos([]);
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }, [input, busy, loadToken]);

  const onImport = useCallback(async () => {
    const text = String(input || '').trim();
    if (!text || busy || !storeState) return;
    setBusy('import');
    try {
      const auth = await loadToken();
      const result = await runImport({
        input: text,
        store: storeState,
        token: auth,
        // UI 档位：插件由用户在这里确认安装（agent 工具侧永远为 false）
        allowPlugins: true,
        mcp: { load: () => getMcpServers(), save: list => saveMcpServers(list) },
      });
      if (!mountedRef.current) return;
      if (!result.ok && !(result.installSummary && result.installSummary.total > 0)) {
        Alert.alert(t('workspace.import.failTitle'), t('workspace.import.failBody', { reason: String(result.error || '') }));
        return;
      }
      const summary = result.installSummary || { total: 0, installed: {}, skipped: 0, errors: 0 };
      Alert.alert(
        t('workspace.import.doneTitle'),
        t('workspace.import.doneBody', {
          count: summary.total,
          skipped: summary.skipped,
          failed: summary.errors,
        }),
      );
      if (onImported) onImported(storeState);
      onClose();
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(t('workspace.import.failTitle'), t('workspace.import.failBody', { reason: String((error && error.message) || error) }));
      }
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }, [input, busy, storeState, loadToken, onImported, onClose, t]);

  const summary = preview && preview.ok ? preview.summary : null;
  const notes = preview && preview.artifacts ? preview.artifacts.notes : [];
  const items = preview && preview.artifacts ? listArtifacts(preview.artifacts) : [];
  const methodMeta = IMPORT_METHODS.find(item => item.id === method) || IMPORT_METHODS[0];
  const canImport = Boolean(summary && summary.total > 0) && !busy;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('workspace.import.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>{t('workspace.import.hint')}</FieldHint>

            <View style={styles.methodRow}>
              {IMPORT_METHODS.map(item => {
                const active = item.id === method;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.methodChip, active && styles.methodChipActive]}
                    onPress={() => { setMethod(item.id); setPreview(null); setRepos([]); }}
                    activeOpacity={0.85}
                    accessibilityLabel={t(item.labelKey)}
                  >
                    <Text style={[styles.methodText, active && styles.methodTextActive]}>{t(item.labelKey)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <FieldLabel style={styles.label}>{t('workspace.import.source')}</FieldLabel>
            <TextField
              value={input}
              onChangeText={setInput}
              placeholder={t(methodMeta.placeholderKey)}
              autoCapitalize="none"
              autoCorrect={false}
              multiline={method === 'paste'}
              style={method === 'paste' ? styles.pasteInput : null}
            />

            <View style={styles.actionRow}>
              <SecondaryButton
                title={busy === 'check' ? t('workspace.import.checking') : t('workspace.import.check')}
                onPress={onCheck}
                small
                disabled={!input.trim() || Boolean(busy)}
              />
              {method === 'github' ? (
                <GhostButton
                  title={busy === 'search' ? t('workspace.import.searching') : t('workspace.import.search')}
                  onPress={onSearch}
                  small
                  disabled={!input.trim() || Boolean(busy)}
                  style={styles.actionSpaced}
                />
              ) : null}
            </View>

            {repos.length > 0 ? (
              <>
                <FieldLabel style={styles.label}>{t('workspace.import.searchResults')}</FieldLabel>
                {repos.map(item => (
                  <TouchableOpacity
                    key={item.fullName}
                    style={styles.repoRow}
                    onPress={() => { setInput(item.fullName); setRepos([]); setPreview(null); }}
                    activeOpacity={0.8}
                  >
                    <View style={styles.repoText}>
                      <Text style={styles.repoName} numberOfLines={1}>{item.fullName}</Text>
                      {item.description ? <Text style={styles.repoDesc} numberOfLines={2}>{item.description}</Text> : null}
                    </View>
                    <Text style={styles.repoStars}>{`★${item.stars}`}</Text>
                  </TouchableOpacity>
                ))}
              </>
            ) : null}

            {preview ? (
              <View style={styles.previewBox}>
                {preview.ok && summary && summary.total > 0 ? (
                  <>
                    <Text style={styles.previewTitle}>
                      {t('workspace.import.previewTitle', { label: preview.label || '' })}
                    </Text>
                    <Text style={styles.previewCounts}>
                      {Object.keys(KIND_KEYS)
                        .filter(kind => (summary[kind] || 0) > 0)
                        .map(kind => `${t(KIND_KEYS[kind])} ${summary[kind]}`)
                        .join(' · ')}
                    </Text>
                    {items.map(item => (
                      <Text key={`${item.kind}:${item.name}`} style={styles.previewItem} numberOfLines={1}>
                        {`· ${t(KIND_KEYS[item.kind])} ${item.name}`}
                      </Text>
                    ))}
                    {notes.map((note, index) => (
                      <Text key={`note-${index}`} style={styles.previewNote}>
                        {NOTE_KEYS[note.reason] ? t(NOTE_KEYS[note.reason], { name: note.name || '' }) : ''}
                      </Text>
                    ))}
                    {previewWarnings(summary, preview.meta, t).map((text, index) => (
                      <Text key={`warn-${index}`} style={styles.previewNote}>{text}</Text>
                    ))}
                  </>
                ) : (
                  <Text style={styles.previewEmpty}>
                    {preview.ok ? t('workspace.import.previewNone') : t('workspace.import.previewError', { reason: String(preview.error || '') })}
                  </Text>
                )}
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <PrimaryButton
              title={busy === 'import' ? t('workspace.import.importing') : t('workspace.import.import')}
              onPress={onImport}
              disabled={!canImport}
              small
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// 预览清单：把四类资产摊平成 [{ kind, name }]，界面只按 kind 取标签。
function listArtifacts(artifacts) {
  const out = [];
  const push = (kind, list, nameOf) => {
    (Array.isArray(list) ? list : []).forEach(item => out.push({ kind, name: nameOf(item) }));
  };
  push('skill', artifacts.skills, item => item.name || item.slug);
  push('command', artifacts.commands, item => item.displayName || item.name);
  push('agent', artifacts.agents, item => item.displayName || item.name);
  push('mcpServer', artifacts.mcpServers, item => item.name || item.id);
  push('pack', artifacts.packs, item => item.name);
  push('plugin', artifacts.plugins, item => item.name || item.id);
  return out;
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 18,
    maxHeight: '90%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 12 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  methodChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  methodChipActive: { backgroundColor: theme.colors.primaryAlpha(0.25), borderColor: theme.colors.primary },
  methodText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12.5), fontWeight: '700' },
  methodTextActive: { color: theme.colors.accentText },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6, marginBottom: 6 },
  pasteInput: { minHeight: 96, textAlignVertical: 'top', paddingTop: tokens.spacing.md },
  actionRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  actionSpaced: { marginLeft: 8 },
  repoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  repoText: { flex: 1, marginRight: 8 },
  repoName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  repoDesc: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), marginTop: 2, lineHeight: fonts.scaled(16) },
  repoStars: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  previewBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  previewTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  previewCounts: { color: theme.colors.accentText, fontSize: fonts.scaled(12.5), fontWeight: '700', marginTop: 6 },
  previewItem: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 4 },
  previewNote: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(11.5), marginTop: 6, lineHeight: fonts.scaled(16) },
  previewEmpty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  footer: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    alignItems: 'flex-end',
  },
});
