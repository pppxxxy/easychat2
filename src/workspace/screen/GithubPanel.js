// GitHub 工作台（v3 六键）。绑定 token 后即切到此形态：
//   ① 仓库列表（owner+collaborator，可加载更多，点选切换当前仓库）
//   ② 导入本地文件（手机多选 → 复制进当前仓库的本地副本）
//   ③ 新建文件 / 新建文件夹（落点 = 当前仓库 + 树内所选目录）
//   ④ 刷新（重拉列表 + 重扫本地树；远端默认分支没了只标记、不自动删本地）
//   ⑤ 新建仓库  ⑥ 仓库管理（复制链接/重命名/删除）——⑤⑥ 在 3b 落地。
//
// 面板内的一切二级操作（树内预览、新建表单、仓库管理）都是本组件内部的层，
// 不再出现任何 Modal（v2 单屏原则 / v3 §0 的「降级为面板内底部滑层」）。
//
// 删除红线（用户裁决）：本面板只允许**手动**删除仓库，且必须手动输入完整仓库名；
// 后端 restApi.deleteRepo 还有一层 confirm 守卫；agent 工具注册表永不注册删除类工具
// （mcp/riskGate.js 的硬禁止形态 + 守卫断言）。三层任缺一层都删不掉。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton } from '../../ui/index.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getGithubMcpSettings } from '../../storage/githubMcp.js';
import { isTextLike, readTextAttachment } from '../../chat/attachments.js';
import { ensureDirectoryName, ensureTextFileName } from '../naming.js';
import { breadcrumbsOf, directoryChildren } from '../screen/buildTree.js';
import {
  canDeleteRepo,
  createRepo,
  deleteRepo,
  fetchTokenScopes,
  listRepos,
  renameRepo,
  repoWebUrl,
} from '../github/restApi.js';

// 错误码 → i18n 文案键（后端只给 code，文案在这一层收口）。
const ERROR_KEYS = {
  AUTH: 'workspace.github.err.auth',
  FORBIDDEN: 'workspace.github.err.forbidden',
  NOT_FOUND: 'workspace.github.err.notFound',
  RATE_LIMIT: 'workspace.github.err.rateLimit',
  INVALID: 'workspace.github.err.invalid',
  CONFLICT: 'workspace.github.err.conflict',
  INVALID_NAME: 'workspace.github.err.invalidName',
  DELETE_CONFIRM_REQUIRED: 'workspace.github.err.deleteConfirm',
};

export default function GithubPanel({ characterId, storeRef }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState([]);
  const [repoPage, setRepoPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  // 当前仓库 + 本地副本树。
  const [current, setCurrent] = useState(null);
  const [allFiles, setAllFiles] = useState([]);
  const [subdir, setSubdir] = useState('');
  const [search, setSearch] = useState('');
  // 面板内层：'' | 'newEntry' | 'preview' | 'newRepo' | 'manage'
  const [layer, setLayer] = useState('');
  const [entryForm, setEntryForm] = useState({ kind: 'text', name: '', content: '' });
  const [preview, setPreview] = useState(null);
  const [actionBusy, setActionBusy] = useState('');
  // ⑤ 新建仓库表单 / ⑥ 仓库管理（删除需手动输名 + token scope）。
  const [newRepo, setNewRepo] = useState({ name: '', description: '', isPrivate: true, autoInit: false });
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [scopes, setScopes] = useState([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const describeError = useCallback(caught => {
    const code = caught && caught.code;
    return t(ERROR_KEYS[code] || 'workspace.github.err.generic');
  }, [t]);

  const refreshLocal = useCallback(async (ownerId = characterId) => {
    const store = storeRef && storeRef.current;
    if (!store) return;
    try {
      const list = await store.listWorkspaceFiles({ characterId: ownerId });
      if (mountedRef.current) setAllFiles(Array.isArray(list) ? list : []);
    } catch (caught) {
      if (mountedRef.current) setAllFiles([]);
    }
  }, [characterId, storeRef]);

  const loadRepos = useCallback(async (page = 1, resolvedToken = token) => {
    if (!resolvedToken) return;
    setBusy(true);
    setErrorText('');
    try {
      const { repos: list, hasMore: more } = await listRepos({ token: resolvedToken, page });
      if (!mountedRef.current) return;
      setRepos(prev => (page === 1 ? list : [...prev, ...list]));
      setRepoPage(page);
      setHasMore(more);
    } catch (caught) {
      if (mountedRef.current) setErrorText(describeError(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [describeError, token]);

  // 打开面板：读 token（与 MCP 同源，不建第二套凭据）→ 拉仓库列表 + 本地树。
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const settings = await getGithubMcpSettings();
        const resolved = settings && settings.enabled
          ? (settings.authMethod === 'oauth' ? settings.githubAccessToken : settings.githubToken)
          : '';
        if (!alive) return;
        setToken(resolved || '');
        await refreshLocal();
        if (resolved) await loadRepos(1, resolved);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [loadRepos, refreshLocal]);

  const repoPrefix = useCallback(repo => (repo ? `repos/${repo.owner}/${repo.repo}/${repo.branch}/` : ''), []);

  const localCount = useCallback(repo => {
    const prefix = repoPrefix(repo);
    if (!prefix) return 0;
    return allFiles.filter(entry => String(entry).startsWith(prefix) && !String(entry).endsWith('/')).length;
  }, [allFiles, repoPrefix]);

  const selectRepo = useCallback(repo => {
    const next = { owner: repo.owner, repo: repo.repo, branch: repo.defaultBranch || 'main' };
    setCurrent(next);
    setSubdir(repoPrefix(next));
    setSearch('');
    setLayer('');
    setErrorText('');
  }, [repoPrefix]);

  const refreshAll = useCallback(async () => {
    setActionBusy('refresh');
    try {
      await refreshLocal();
      if (token) await loadRepos(1);
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [loadRepos, refreshLocal, token]);

  // 树：当前仓库前缀下的条目（本地副本）。
  const repoEntries = useMemo(() => {
    if (!current) return [];
    const prefix = repoPrefix(current);
    return allFiles.filter(entry => String(entry).startsWith(prefix));
  }, [allFiles, current, repoPrefix]);

  const children = useMemo(() => directoryChildren(repoEntries, subdir), [repoEntries, subdir]);
  const crumbs = useMemo(() => breadcrumbsOf(subdir, t('workspace.panel.breadcrumb.root')), [subdir, t]);

  // 搜索：过滤当前仓库树的全部文件（本地副本全量路径匹配，不区分大小写）。
  const searchResults = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return [];
    const prefix = repoPrefix(current);
    return allFiles
      .filter(entry => !String(entry).endsWith('/'))
      .filter(entry => String(entry).startsWith(prefix))
      .filter(entry => entry.toLowerCase().includes(keyword))
      .slice(0, 50);
  }, [allFiles, current, repoPrefix, search]);

  const openFile = useCallback(async path => {
    const store = storeRef && storeRef.current;
    if (!store) return;
    try {
      const result = await store.readWorkspaceFile({ characterId, path });
      if (mountedRef.current) {
        setPreview(result);
        setLayer('preview');
      }
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.err.open'));
    }
  }, [characterId, storeRef, t]);

  // ② 导入本地文件：手机多选 → 文本文件写进当前仓库的本地副本。
  const importLocalFiles = useCallback(async () => {
    if (!current) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.noRepo'));
      return;
    }
    const store = storeRef && storeRef.current;
    if (!store) return;
    setActionBusy('import');
    try {
      const DocumentPicker = require('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (!result || result.canceled) return;
      const assets = Array.isArray(result.assets) ? result.assets : [];
      let written = 0;
      let skipped = 0;
      for (const asset of assets) {
        const name = String((asset && asset.name) || '').split('/').pop() || '';
        if (!name || !isTextLike(name, asset && asset.mime)) {
          skipped += 1;
          continue;
        }
        try {
          const text = await readTextAttachment(asset.uri);
          await store.writeWorkspaceFile({ characterId, path: `${repoPrefix(current)}${name}`, content: text });
          written += 1;
        } catch (caught) {
          skipped += 1;
        }
      }
      await refreshLocal();
      if (mountedRef.current) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.done', { written, skipped }));
      }
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.errBody'));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, refreshLocal, repoPrefix, storeRef, t]);

  // ③ 新建文件 / 文件夹：落点 = 树内当前目录。
  const submitEntry = useCallback(async () => {
    const store = storeRef && storeRef.current;
    if (!store || !current) return;
    const name = String(entryForm.name || '').trim();
    if (!name) return;
    setActionBusy('entry');
    try {
      if (entryForm.kind === 'folder') {
        const path = ensureDirectoryName(name);
        await store.createWorkspaceDirectory({ characterId, path: `${subdir}${path}` });
      } else {
        const path = ensureTextFileName(name);
        await store.writeWorkspaceFile({ characterId, path: `${subdir}${path}`, content: String(entryForm.content || '') });
      }
      setEntryForm({ kind: entryForm.kind, name: '', content: '' });
      setLayer('');
      await refreshLocal();
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.err.save'));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, entryForm, refreshLocal, storeRef, subdir, t]);

  // ⑥ 仓库管理：打开时读 token scope（删除仓库需要 delete_repo，没勾就明确引导，
  // 不是点了才报错）。
  const openManage = useCallback(async () => {
    if (!current) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.needRepo'));
      return;
    }
    setRenameValue(current.repo);
    setDeleteConfirm('');
    setLayer('manage');
    if (token) {
      try {
        const list = await fetchTokenScopes({ token });
        if (mountedRef.current) setScopes(list);
      } catch (caught) {
        if (mountedRef.current) setScopes([]);
      }
    }
  }, [current, t, token]);

  const copyRepoLink = useCallback(async () => {
    if (!current) return;
    try {
      await Clipboard.setStringAsync(repoWebUrl(current.owner, current.repo));
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.copied'));
    } catch (caught) {}
  }, [current, t]);

  const submitRename = useCallback(async () => {
    if (!current) return;
    const next = renameValue.trim();
    if (!next || next === current.repo) return;
    setActionBusy('rename');
    try {
      const updated = await renameRepo({ token, owner: current.owner, repo: current.repo, newName: next });
      const branch = updated.defaultBranch || current.branch;
      if (mountedRef.current) {
        setRepos(prev => prev.map(item => (item.fullName === `${current.owner}/${current.repo}` ? updated : item)));
        setCurrent({ owner: updated.owner, repo: updated.repo, branch });
        setSubdir(`repos/${updated.owner}/${updated.repo}/${branch}/`);
        setLayer('');
      }
      await refreshLocal();
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.renamed'));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [current, describeError, refreshLocal, renameValue, t, token]);

  // 删除仓库——三层硬约束，任缺一层都删不掉：
  // ① UI：必须手动输入完整仓库名（下面按 deleteConfirm 是否匹配禁用按钮）；
  // ② 权限：token 必须带 delete_repo scope（没勾时明确提示去哪勾）；
  // ③ 后端：restApi.deleteRepo 要求 confirm 逐字相同，否则连请求都不发。
  const submitDelete = useCallback(async () => {
    if (!current) return;
    const fullName = `${current.owner}/${current.repo}`;
    if (deleteConfirm.trim() !== fullName) return;
    if (!canDeleteRepo(scopes)) return;
    setActionBusy('delete');
    try {
      await deleteRepo({ token, owner: current.owner, repo: current.repo, confirm: fullName });
      if (mountedRef.current) {
        setRepos(prev => prev.filter(item => item.fullName !== fullName));
        setCurrent(null);
        setSubdir('');
        setDeleteConfirm('');
        setLayer('');
      }
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.deleteDone'));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [current, deleteConfirm, describeError, scopes, t, token]);

  // ⑤ 新建仓库：成功后自动成为当前仓库，并在本地建同名骨架目录。
  const submitCreateRepo = useCallback(async () => {
    const name = newRepo.name.trim();
    if (!name) return;
    setActionBusy('createRepo');
    try {
      const created = await createRepo({
        token,
        name,
        description: newRepo.description,
        isPrivate: newRepo.isPrivate,
        autoInit: newRepo.autoInit,
      });
      const branch = created.defaultBranch || 'main';
      const store = storeRef && storeRef.current;
      if (store) {
        await store
          .createWorkspaceDirectory({ characterId, path: `repos/${created.owner}/${created.repo}/${branch}` })
          .catch(() => {});
      }
      if (mountedRef.current) {
        setRepos(prev => [created, ...prev.filter(item => item.fullName !== created.fullName)]);
        setNewRepo({ name: '', description: '', isPrivate: true, autoInit: false });
      }
      selectRepo(created);
      await refreshLocal();
      Alert.alert(t('workspace.github.title'), t('workspace.github.createRepo.done', { name: created.fullName }));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, describeError, newRepo, refreshLocal, selectRepo, storeRef, t, token]);

  const canAct = Boolean(current) && Boolean(storeRef && storeRef.current);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.body}>
        {layer === 'preview' && preview ? (
          <>
            <TouchableOpacity style={styles.layerHeader} onPress={() => { setLayer(''); setPreview(null); }} activeOpacity={0.8}>
              <Ionicons name="chevron-back" size={18} color={theme.colors.text} />
              <Text style={styles.layerTitle} numberOfLines={1}>{preview.path}</Text>
            </TouchableOpacity>
            <FieldHint>{preview.truncated ? t('workspace.panel.preview.truncated') : t('workspace.panel.preview.hint')}</FieldHint>
            <Text style={styles.previewText}>{preview.content}</Text>
          </>
        ) : (
          <>
            <FieldLabel>{t('workspace.github.repoList.title')}</FieldLabel>
            {loading ? <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View> : null}
            {!loading && !token ? (
              <>
                <FieldHint>{t('workspace.github.guide.body')}</FieldHint>
                <FieldHint>{t('workspace.github.guide.connectHint')}</FieldHint>
              </>
            ) : null}
            {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
            {repos.map(repo => {
              const active = current && current.owner === repo.owner && current.repo === repo.repo;
              return (
                <TouchableOpacity
                  key={repo.fullName}
                  style={[styles.repoRow, active && styles.repoRowActive]}
                  onPress={() => selectRepo(repo)}
                  activeOpacity={0.85}
                >
                  <View style={styles.repoMain}>
                    <Text style={styles.repoName} numberOfLines={1}>{repo.fullName}</Text>
                    <Text style={styles.repoMeta} numberOfLines={1}>
                      {[repo.defaultBranch, repo.isPrivate ? t('workspace.panel.repo.visibility.private') : t('workspace.panel.repo.visibility.public'), repo.pushedAt].filter(Boolean).join(' · ')}
                      {localCount(repo) > 0 ? ` · ${t('workspace.github.repoList.localCount', { count: localCount(repo) })}` : ''}
                    </Text>
                  </View>
                  {active ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
            {hasMore && !busy ? (
              <View style={styles.actions}>
                <PrimaryButton title={t('workspace.panel.repo.loadMore')} small onPress={() => loadRepos(repoPage + 1)} />
              </View>
            ) : null}

            {current ? (
              <>
                <FieldLabel>{t('workspace.github.tree.title', { name: `${current.owner}/${current.repo}` })}</FieldLabel>
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder={t('workspace.github.search.placeholder')}
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {search.trim() ? (
                  searchResults.length === 0 ? (
                    <FieldHint>{t('workspace.github.search.empty')}</FieldHint>
                  ) : (
                    searchResults.map(path => (
                      <TouchableOpacity key={path} style={styles.fileRow} onPress={() => openFile(path)} activeOpacity={0.8}>
                        <Ionicons name="search-outline" size={15} color={theme.colors.primaryMuted} />
                        <Text style={styles.fileName} numberOfLines={1}>{path}</Text>
                      </TouchableOpacity>
                    ))
                  )
                ) : (
                  <>
                    <View style={styles.crumbRow}>
                      {crumbs.map((crumb, index) => (
                        <View key={crumb.path || 'root'} style={styles.crumbItem}>
                          {index > 0 ? <Ionicons name="chevron-forward" size={12} color={theme.colors.textFaint} /> : null}
                          <TouchableOpacity onPress={() => setSubdir(crumb.path)} activeOpacity={0.7}>
                            <Text style={[styles.crumbText, index === crumbs.length - 1 && styles.crumbTextActive]} numberOfLines={1}>
                              {crumb.name}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                    {children.length === 0 ? <FieldHint>{t('workspace.github.tree.empty')}</FieldHint> : null}
                    {children.map(child => (
                      <View key={child.path} style={styles.fileRow}>
                        <TouchableOpacity
                          style={styles.fileMain}
                          onPress={() => (child.isDirectory ? setSubdir(child.path) : openFile(child.path))}
                          activeOpacity={0.8}
                        >
                          <Ionicons
                            name={child.isDirectory ? 'folder-outline' : 'document-text-outline'}
                            size={16}
                            color={theme.colors.primaryMuted}
                          />
                          <Text style={styles.fileName} numberOfLines={1}>{child.name}</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                )}

                {layer === 'newEntry' ? (
                  <View style={styles.formCard}>
                    <FieldLabel>
                      {entryForm.kind === 'folder' ? t('workspace.panel.form.newFolder') : t('workspace.panel.form.newText')}
                    </FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={entryForm.name}
                      onChangeText={value => setEntryForm(current2 => ({ ...current2, name: value }))}
                      placeholder={entryForm.kind === 'folder' ? t('workspace.panel.form.nameFolder') : t('workspace.panel.form.nameText')}
                      placeholderTextColor={theme.colors.textFaint}
                    />
                    {entryForm.kind === 'text' ? (
                      <TextInput
                        style={[styles.input, styles.contentInput]}
                        value={entryForm.content}
                        onChangeText={value => setEntryForm(current2 => ({ ...current2, content: value }))}
                        placeholder={t('workspace.panel.form.content')}
                        placeholderTextColor={theme.colors.textFaint}
                        multiline
                      />
                    ) : null}
                    <View style={styles.actions}>
                      <GhostButton title={t('common.cancel')} small onPress={() => setLayer('')} />
                      <PrimaryButton title={t('common.save')} small onPress={submitEntry} />
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}

            {layer === 'newRepo' ? (
              <View style={styles.formCard}>
                <FieldLabel>{t('workspace.github.createRepo.title')}</FieldLabel>
                <TextInput
                  style={styles.input}
                  value={newRepo.name}
                  onChangeText={value => setNewRepo(current2 => ({ ...current2, name: value }))}
                  placeholder={t('workspace.github.createRepo.namePlaceholder')}
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TextInput
                  style={styles.input}
                  value={newRepo.description}
                  onChangeText={value => setNewRepo(current2 => ({ ...current2, description: value }))}
                  placeholder={t('workspace.github.createRepo.descPlaceholder')}
                  placeholderTextColor={theme.colors.textFaint}
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>{t('workspace.github.createRepo.private')}</Text>
                  <Switch
                    value={newRepo.isPrivate}
                    onValueChange={value => setNewRepo(current2 => ({ ...current2, isPrivate: value }))}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>{t('workspace.github.createRepo.autoInit')}</Text>
                  <Switch
                    value={newRepo.autoInit}
                    onValueChange={value => setNewRepo(current2 => ({ ...current2, autoInit: value }))}
                    trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                    thumbColor={theme.colors.primaryContrast}
                  />
                </View>
                <FieldHint>{t('workspace.github.createRepo.hint')}</FieldHint>
                <View style={styles.actions}>
                  <GhostButton title={t('common.cancel')} small onPress={() => setLayer('')} />
                  <PrimaryButton title={t('workspace.github.createRepo.action')} small onPress={submitCreateRepo} />
                </View>
              </View>
            ) : null}

            {layer === 'manage' && current ? (
              <View style={styles.formCard}>
                <FieldLabel>{t('workspace.github.manage.title')}</FieldLabel>
                <TouchableOpacity style={styles.manageRow} onPress={copyRepoLink} activeOpacity={0.8}>
                  <Ionicons name="link-outline" size={16} color={theme.colors.primaryMuted} />
                  <Text style={styles.manageText}>{t('workspace.github.manage.copy')}</Text>
                </TouchableOpacity>
                <TextInput
                  style={styles.input}
                  value={renameValue}
                  onChangeText={setRenameValue}
                  placeholder={t('workspace.github.manage.renamePlaceholder')}
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={styles.actions}>
                  <PrimaryButton title={t('workspace.github.manage.renameAction')} small onPress={submitRename} />
                </View>
                <FieldHint>{t('workspace.github.manage.renameLocalNote')}</FieldHint>

                <View style={styles.dangerBlock}>
                  <Text style={styles.dangerTitle}>{t('workspace.github.manage.delete')}</Text>
                  {canDeleteRepo(scopes) ? (
                    <>
                      <FieldHint>{t('workspace.github.manage.deleteHint', { name: `${current.owner}/${current.repo}` })}</FieldHint>
                      <TextInput
                        style={styles.input}
                        value={deleteConfirm}
                        onChangeText={setDeleteConfirm}
                        placeholder={t('workspace.github.manage.deletePlaceholder', { name: `${current.owner}/${current.repo}` })}
                        placeholderTextColor={theme.colors.textFaint}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <View style={styles.actions}>
                        <PrimaryButton
                          title={t('workspace.github.manage.deleteAction')}
                          small
                          disabled={deleteConfirm.trim() !== `${current.owner}/${current.repo}`}
                          onPress={submitDelete}
                        />
                      </View>
                    </>
                  ) : (
                    <FieldHint>{t('workspace.github.manage.deleteNoScope')}</FieldHint>
                  )}
                </View>
              </View>
            ) : null}

            {current ? (
              <View style={styles.pushBar}>
                <Text style={styles.pushText}>{t('workspace.github.push.pending', { count: localCount(current) })}</Text>
                <FieldHint>{t('workspace.github.push.hint')}</FieldHint>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* 六键工具栏（3a：①②③④；⑤⑥ 在 3b 落地）。 */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.toolButton}
          onPress={() => loadRepos(1)}
          disabled={!token || busy}
          accessibilityLabel={t('workspace.github.toolbar.repos')}
        >
          <Ionicons name="list-outline" size={19} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={importLocalFiles}
          disabled={!canAct || actionBusy === 'import'}
          accessibilityLabel={t('workspace.github.toolbar.importLocal')}
        >
          <Ionicons name="cloud-upload-outline" size={19} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={() => { setEntryForm({ kind: 'text', name: '', content: '' }); setLayer('newEntry'); }}
          disabled={!canAct}
          accessibilityLabel={t('workspace.github.toolbar.newEntry')}
        >
          <Ionicons name="add-outline" size={21} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolButton}
          onPress={refreshAll}
          disabled={actionBusy === 'refresh'}
          accessibilityLabel={t('workspace.github.toolbar.refresh')}
        >
          <Ionicons name="refresh-outline" size={19} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !token && styles.toolDisabled]}
          onPress={() => { setNewRepo({ name: '', description: '', isPrivate: true, autoInit: false }); setLayer('newRepo'); }}
          disabled={!token}
          accessibilityLabel={t('workspace.github.toolbar.createRepo')}
        >
          <Ionicons name="add-circle-outline" size={19} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={openManage}
          disabled={!canAct}
          accessibilityLabel={t('workspace.github.toolbar.manage')}
        >
          <Ionicons name="options-outline" size={19} color={theme.colors.primarySoft} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
  errorText: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginBottom: 8 },
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
  repoRowActive: { borderColor: theme.colors.primary },
  repoMain: { flex: 1, marginRight: 8 },
  repoName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  repoMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  searchInput: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: fonts.scaled(12.5),
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  crumbRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
  crumbItem: { flexDirection: 'row', alignItems: 'center', marginRight: 4 },
  crumbText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginHorizontal: 2 },
  crumbTextActive: { color: theme.colors.primary, fontWeight: '700' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  fileMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  fileName: { color: theme.colors.text, fontSize: fonts.scaled(12.5), marginLeft: 8, flex: 1 },
  formCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginTop: 10,
  },
  input: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    color: theme.colors.text,
    fontSize: fonts.scaled(12.5),
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
  },
  contentInput: { minHeight: 72, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  switchLabel: { color: theme.colors.text, fontSize: fonts.scaled(12.5), flex: 1, marginRight: 8 },
  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 8,
  },
  manageText: { color: theme.colors.text, fontSize: fonts.scaled(12.5), marginLeft: 8 },
  dangerBlock: {
    marginTop: 14,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    paddingTop: 12,
  },
  dangerTitle: { color: theme.colors.danger, fontSize: fonts.scaled(13), fontWeight: '700', marginBottom: 6 },
  pushBar: {
    marginTop: 14,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    paddingTop: 10,
  },
  pushText: { color: theme.colors.text, fontSize: fonts.scaled(12.5), fontWeight: '600', marginBottom: 2 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  layerHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  layerTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 6, flex: 1 },
  previewText: { color: theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceAlt,
    paddingVertical: 6,
  },
  toolButton: { paddingHorizontal: 14, paddingVertical: 6 },
  toolDisabled: { opacity: 0.4 },
});
