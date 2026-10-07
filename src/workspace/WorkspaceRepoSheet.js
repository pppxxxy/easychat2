// 工作区「从 GitHub 导入」弹层：列我的仓库 → 选分支 → codeload zip 快照 → 解压进沙盒。
//
// 凭据复用 MCP 设置里的 token/OAuth（与 mcpTools.js 同源读取，不建第二套存储）。
// 未连接时显示引导卡 + 「公开仓库」直输模式（免凭据，只能拉公开仓库）。
// 产物是**分支快照**：没有 .git 历史；提交回 GitHub 由工作区 agent 走 GitHub 工具。
// URL/解析/限额/zip-slip 全部在 repoImport.js（纯函数，Node 直测），这里只做流程与渲染。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EmptyState, FieldHint, FieldLabel, PrimaryButton, SheetHeader, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getGithubMcpSettings } from '../storage/githubMcp.js';
import {
  buildBranchesApiUrl,
  buildRepoApiUrl,
  buildRepoZipUrl,
  buildReposApiUrl,
  extractRepoFiles,
  parseRepoFullName,
  REPO_IMPORT_LIMITS,
} from './repoImport.js';

function authFail(status) {
  const error = new Error(`GitHub API HTTP ${status}`);
  error.code = status === 401 || status === 403 ? 'REPO_AUTH' : 'REPO_HTTP';
  return error;
}

export default function WorkspaceRepoSheet({ visible, onClose, characterId, storeRef, onImported }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // loading → guide（无凭据）| list（有凭据）→ branches → importing
  const [phase, setPhase] = useState('loading');
  const [token, setToken] = useState('');
  const [repos, setRepos] = useState([]);
  const [repoPage, setRepoPage] = useState(1);
  const [reposDone, setReposDone] = useState(false);
  const [search, setSearch] = useState('');
  const [publicInput, setPublicInput] = useState('');
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');

  const reset = useCallback(() => {
    setRepos([]); setRepoPage(1); setReposDone(false); setSearch('');
    setPublicInput(''); setSelectedRepo(null); setBranches([]); setBranch('');
    setBusy(false); setErrorText('');
  }, []);

  useEffect(() => {
    if (!visible) return;
    reset();
    setPhase('loading');
    (async () => {
      try {
        const settings = await getGithubMcpSettings();
        const resolvedToken = settings && settings.enabled
          ? (settings.authMethod === 'oauth' ? settings.githubAccessToken : settings.githubToken)
          : '';
        setToken(resolvedToken || '');
        if (!resolvedToken) {
          setPhase('guide');
          return;
        }
        const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${resolvedToken}` };
        const response = await fetch(buildReposApiUrl({ page: 1 }), { headers });
        if (!response.ok) throw authFail(response.status);
        const list = await response.json();
        setRepos(Array.isArray(list) ? list : []);
        setReposDone(!Array.isArray(list) || list.length < 30);
        setRepoPage(1);
        setPhase('list');
      } catch (error) {
        setErrorText(error && error.code === 'REPO_AUTH'
          ? t('workspace.panel.repo.errAuth')
          : t('workspace.panel.repo.errList'));
        setPhase('guide');
      }
    })();
  }, [visible, reset, t]);

  const loadMoreRepos = useCallback(async () => {
    if (busy || reposDone || !token) return;
    setBusy(true);
    try {
      const nextPage = repoPage + 1;
      const response = await fetch(buildReposApiUrl({ page: nextPage }), {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw authFail(response.status);
      const list = await response.json();
      setRepos(current => [...current, ...(Array.isArray(list) ? list : [])]);
      setRepoPage(nextPage);
      setReposDone(!Array.isArray(list) || list.length < 30);
    } catch (error) {
      setErrorText(t('workspace.panel.repo.errList'));
    } finally {
      setBusy(false);
    }
  }, [busy, reposDone, repoPage, token]);

  const openPublicRepo = useCallback(async () => {
    const parsed = parseRepoFullName(publicInput);
    if (!parsed) {
      Alert.alert(t('workspace.panel.repo.title'), t('workspace.panel.repo.errName'));
      return;
    }
    setBusy(true);
    setErrorText('');
    try {
      const response = await fetch(buildRepoApiUrl(parsed), { headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw authFail(response.status);
      const meta = await response.json();
      const repo = { owner: parsed.owner, repo: parsed.repo, default_branch: meta.default_branch || 'main', private: false };
      setSelectedRepo(repo);
      try {
        const branchResponse = await fetch(buildBranchesApiUrl(parsed), { headers: { Accept: 'application/vnd.github+json' } });
        setBranches(branchResponse.ok ? await branchResponse.json() : []);
      } catch (error) {
        setBranches([]);
      }
      setBranch(repo.default_branch);
      setPhase('branches');
    } catch (error) {
      setErrorText(t('workspace.panel.repo.errList'));
    } finally {
      setBusy(false);
    }
  }, [publicInput, t]);

  const pickRepo = useCallback(async repo => {
    setBusy(true);
    setErrorText('');
    try {
      const owner = repo.owner && repo.owner.login ? repo.owner.login : String(repo.full_name || '').split('/')[0];
      const name = repo.name;
      setSelectedRepo({ owner, repo: name, default_branch: repo.default_branch || 'main', private: repo.private === true });
      let list = [];
      try {
        const response = await fetch(buildBranchesApiUrl({ owner, repo: name }), {
          headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (response.ok) list = await response.json();
      } catch (error) { list = []; }
      setBranches(Array.isArray(list) ? list : []);
      setBranch(repo.default_branch || 'main');
      setPhase('branches');
    } finally {
      setBusy(false);
    }
  }, [token]);

  const writeImportedFiles = useCallback(async (repo, branchName, files, existingPaths, overwrite) => {
    const store = storeRef && storeRef.current;
    if (!store) throw Object.assign(new Error('workspace store unavailable'), { code: 'REPO_NO_STORE' });
    const base = `repos/${repo}/${branchName}/`;
    const written = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const path = `${base}${file.path}`;
        if (!overwrite && existingPaths.has(path)) continue;
        await store.writeWorkspaceFile({ characterId, path, content: file.content });
        written.push(path);
        if (index % 10 === 9 || index === files.length - 1) {
          setBusy(true);
        }
      }
    } catch (error) {
      // 半成品清理：写了一半失败时把本次已写的文件删掉，不留静默垃圾。
      for (const path of written) {
        await store.deleteFile({ characterId, path }).catch(() => {});
      }
      throw error;
    }
    return { written, base };
  }, [characterId, storeRef]);

  const startImport = useCallback(async (branchName) => {
    const store = storeRef && storeRef.current;
    if (!store || !selectedRepo || busy) return;
    const repo = selectedRepo.repo;
    setBusy(true);
    setErrorText('');
    try {
      setPhase('importing');
      const zipUrl = buildRepoZipUrl({ owner: selectedRepo.owner, repo, branch: branchName });
      const response = await fetch(zipUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw authFail(response.status);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > REPO_IMPORT_LIMITS.MAX_DOWNLOAD_BYTES) {
        throw Object.assign(new Error('zip too large (Content-Length)'), { code: 'REPO_LIMIT_DOWNLOAD' });
      }
      const buffer = await response.arrayBuffer();
      const { files, skippedBinary, skippedSlip, skippedOversize } = extractRepoFiles(
        new Uint8Array(buffer),
        `${repo}-${branchName}/`
      );
      if (files.length === 0) {
        Alert.alert(t('workspace.panel.repo.title'), t('workspace.panel.repo.errNoFiles'));
        setPhase('branches');
        return;
      }
      // 已存在同名目录：覆盖 / 合并 / 取消 三选（合并 = 已存在的文件跳过）。
      const base = `repos/${repo}/${branchName}/`;
      const allPaths = (await store.listWorkspaceFiles({ characterId })) || [];
      const existingPaths = new Set(allPaths.filter(path => String(path).startsWith(base)));
      let overwrite = true;
      if (existingPaths.size > 0) {
        const choice = await new Promise(resolve => {
          Alert.alert(
            t('workspace.panel.repo.exists.title'),
            t('workspace.panel.repo.exists.body', { path: base, count: existingPaths.size }),
            [
              { text: t('common.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
              { text: t('workspace.panel.repo.exists.merge'), onPress: () => resolve('merge') },
              { text: t('workspace.panel.repo.exists.overwrite'), style: 'destructive', onPress: () => resolve('overwrite') },
            ],
            { cancelable: false }
          );
        });
        if (choice === 'cancel') {
          setPhase('branches');
          return;
        }
        overwrite = choice === 'overwrite';
      }
      const { written } = await writeImportedFiles(repo, branchName, files, existingPaths, overwrite);
      if (typeof onImported === 'function') onImported();
      setPhase('list');
      Alert.alert(
        t('workspace.panel.repo.done.title'),
        t('workspace.panel.repo.done.body', {
          count: written.length,
          binary: skippedBinary,
          oversize: skippedOversize,
          slip: skippedSlip,
        })
      );
    } catch (error) {
      setPhase('branches');
      Alert.alert(
        t('workspace.panel.repo.title'),
        t('workspace.panel.repo.errImport'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('workspace.panel.repo.retry'), onPress: () => startImport(branchName) },
        ]
      );
    } finally {
      setBusy(false);
    }
  }, [busy, characterId, onImported, selectedRepo, storeRef, t, token, writeImportedFiles]);

  const visibleRepos = repos.filter(item => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return true;
    return String(item.full_name || '').toLowerCase().includes(keyword);
  });

  const repoMetaLine = item => {
    const visibility = item.private ? t('workspace.panel.repo.visibility.private') : t('workspace.panel.repo.visibility.public');
    const pushed = item.pushed_at ? String(item.pushed_at).slice(0, 10) : '';
    return [visibility, item.language || '', pushed].filter(Boolean).join(' · ');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <SheetHeader title={t('workspace.panel.repo.title')} onClose={onClose} />
        <ScrollView contentContainerStyle={styles.body}>
          <FieldHint>{t('workspace.panel.repo.hint')}</FieldHint>
          {phase === 'loading' ? (
            <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>
          ) : null}

          {phase === 'guide' ? (
            <>
              <EmptyState
                icon="logo-github"
                title={t('workspace.panel.repo.guide.title')}
                description={errorText || t('workspace.panel.repo.guide.body')}
              />
              <View style={styles.section}>
                <PrimaryButton title={t('workspace.panel.repo.guide.connect')} onPress={onClose} />
                <FieldHint>{t('workspace.panel.repo.guide.connectHint')}</FieldHint>
                <FieldLabel>{t('workspace.panel.repo.public.title')}</FieldLabel>
                <TextField
                  value={publicInput}
                  onChangeText={setPublicInput}
                  placeholder={t('workspace.panel.repo.public.placeholder')}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={styles.actions}>
                  <PrimaryButton
                    title={busy ? t('workspace.panel.repo.busy') : t('workspace.panel.repo.public.action')}
                    small
                    onPress={openPublicRepo}
                  />
                </View>
              </View>
            </>
          ) : null}

          {phase === 'list' ? (
            <>
              <TextField
                value={search}
                onChangeText={setSearch}
                placeholder={t('workspace.panel.repo.search')}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {visibleRepos.length === 0 && !busy ? (
                <EmptyState icon="logo-github" title={t('workspace.panel.repo.empty.title')} description={t('workspace.panel.repo.empty.body')} />
              ) : null}
              {visibleRepos.map(item => (
                <TouchableOpacity
                  key={String(item.id || item.full_name)}
                  style={styles.repoRow}
                  onPress={() => pickRepo(item)}
                  activeOpacity={0.8}
                >
                  <View style={styles.repoMain}>
                    <Text style={styles.repoName} numberOfLines={1}>{item.full_name || item.name}</Text>
                    <Text style={styles.repoMeta} numberOfLines={1}>{repoMetaLine(item)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={theme.colors.textFaint} />
                </TouchableOpacity>
              ))}
              {!reposDone && visibleRepos.length > 0 ? (
                <View style={styles.actions}>
                  <PrimaryButton title={busy ? t('workspace.panel.repo.busy') : t('workspace.panel.repo.loadMore')} small onPress={loadMoreRepos} />
                </View>
              ) : null}
            </>
          ) : null}

          {phase === 'branches' ? (
            <>
              <View style={styles.repoRow}>
                <View style={styles.repoMain}>
                  <Text style={styles.repoName} numberOfLines={1}>
                    {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.repo}` : ''}
                  </Text>
                  <Text style={styles.repoMeta} numberOfLines={1}>
                    {selectedRepo && selectedRepo.private
                      ? t('workspace.panel.repo.visibility.private')
                      : t('workspace.panel.repo.visibility.public')}
                  </Text>
                </View>
              </View>
              <FieldLabel>{t('workspace.panel.repo.branch.label')}</FieldLabel>
              {(branches.length > 0 ? branches.map(item => item.name) : [selectedRepo ? selectedRepo.default_branch : 'main']).map(name => (
                <TouchableOpacity
                  key={name}
                  style={[styles.repoRow, branch === name && styles.branchRowActive]}
                  onPress={() => setBranch(name)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.repoName} numberOfLines={1}>{name}</Text>
                  {branch === name ? <Ionicons name="checkmark" size={15} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              ))}
              <FieldHint>{t('workspace.panel.repo.branch.hint')}</FieldHint>
              <View style={styles.actions}>
                <PrimaryButton
                  title={busy ? t('workspace.panel.repo.busy') : t('workspace.panel.repo.import.action')}
                  onPress={() => startImport(branch)}
                />
              </View>
              <FieldHint>{t('workspace.panel.repo.snapshotNote')}</FieldHint>
            </>
          ) : null}

          {phase === 'importing' ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={styles.importingText}>{t('workspace.panel.repo.importing')}</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  section: { marginTop: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  repoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  branchRowActive: { borderColor: theme.colors.primary },
  repoMain: { flex: 1, marginRight: 8 },
  repoName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  repoMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  importingText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 8 },
});
