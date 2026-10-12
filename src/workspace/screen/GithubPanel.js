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
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton } from '../../ui/index.js';
import DiffView from '../DiffView.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getRepoSnapshot } from '../../storage/workspace.js';
import { breadcrumbsOf, directoryChildren, mergeManifestEntries } from '../screen/buildTree.js';
import { diffRepoSnapshot } from './repoDiff.js';
import { listRollbackSnapshots } from '../rollbackBaseline.js';
import { formatSkippedList } from '../repoImport.js';
import { canDeleteRepo } from '../github/restApi.js';
import createStyles from './githubPanelStyles.js';
import BuildSection from './github/BuildSection.js';
import useGithubBuild from './github/useGithubBuild.js';
import useGithubHistory from './github/useGithubHistory.js';
import useRepoPull from './github/useRepoPull.js';
import useRepoBranch from './github/useRepoBranch.js';
import useRepoPush from './github/useRepoPush.js';
import useRepoManage from './github/useRepoManage.js';
import useRepoList from './github/useRepoList.js';
import useRepoFiles from './github/useRepoFiles.js';

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

export default function GithubPanel({ characterId, storeRef, onHandoff }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [token, setToken] = useState('');
  // 仓库列表（token/loading/repos/分页/错误）与刷新入口已外提到 github/useRepoList.js。
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
  // ⑤ 新建仓库 / ⑥ 仓库管理的状态与动作已外提到 github/useRepoManage.js。
  // 拉取快照（codeload zipball → 本地副本）：分支、进度、取消。
  const [pullBranch, setPullBranch] = useState('main');

  const [rollbackInfo, setRollbackInfo] = useState(null);
  // B1 分支选择器 / C1 清单先行 / 快速检出的状态与动作已外提到 github/useRepoBranch.js。
  // C3 批量推送的状态与动作已外提到 github/useRepoPush.js。
  // 本地副本清单快照（最近一次拉取/推送时的文件列表）：待同步 = 本地新增 + 本地删除。
  const [snapshotPaths, setSnapshotPaths] = useState([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // H3：面板（重）挂载时列一次回滚基线（只读文件名，轻）——存在即显示「回滚最近一次推送」。
  // G2 的「上次拉取跳过清单」读取已随拉取域外提到 useRepoPull。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const snapshots = await listRollbackSnapshots(storeRef && storeRef.current, characterId);
        if (alive && snapshots.length > 0) {
          setRollbackInfo({ at: snapshots[0].ts });
        }
      } catch (error) {}
    })();
    return () => { alive = false; };
  }, [characterId]);

  const describeError = useCallback(caught => {
    const code = caught && caught.code;
    return t(ERROR_KEYS[code] || 'workspace.github.err.generic');
  }, [t]);

  // H1 云构建的状态与动作已抽到 github/useGithubBuild.js；展示层在 github/BuildSection.js。
  const {
    buildWorkflow,
    setBuildWorkflow,
    buildBusy,
    buildRuns,
    buildLog,
    setBuildLog,
    buildNotice,
    refreshBuildRuns,
    submitBuild,
    openBuildLog,
  } = useGithubBuild({ current, token, pullBranch, describeError, mountedRef, t });

  // E5 提交历史 / 单提交 diff / PR 创建的状态与动作已抽到 github/useGithubHistory.js。
  const {
    historyOpen,
    setHistoryOpen,
    historyCommits,
    historyPage,
    historyBusy,
    historyError,
    historyDiff,
    prBusy,
    loadHistory,
    openCommitDiff,
    submitCreatePr,
  } = useGithubHistory({ current, token, pullBranch, describeError, mountedRef, t });

  // B1 分支选择器 / B2 默认分支对齐 / C1 清单缓存 / 快速检出的状态与动作已外提到 github/useRepoBranch.js。
  const {
    branchOptions,
    branchBusy,
    branchError,
    branchOverLimit,
    manifestEntries,
    manifestTruncated,
    checkoutBusy,
    quickCheckout,
  } = useRepoBranch({
    characterId,
    storeRef,
    current,
    pullBranch,
    token,
    describeError,
    mountedRef,
    t,
    setPullBranch,
    setCurrent,
    setSubdir,
    setSnapshotPaths,
  });

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


  const repoPrefix = useCallback(repo => (repo ? `repos/${repo.owner}/${repo.repo}/${repo.branch}/` : ''), []);

  // 仓库列表域（token 读取 / 分页加载 / 刷新入口 / 本地计数）已外提到 github/useRepoList.js。
  const {
    loading,
    repos,
    repoPage,
    hasMore,
    busy,
    errorText,
    setErrorText,
    setRepos,
    loadRepos,
    localCount,
    refreshAll,
  } = useRepoList({
    mountedRef,
    describeError,
    refreshLocal,
    repoPrefix,
    allFiles,
    setActionBusy,
    token,
    setToken,
  });

  const selectRepo = useCallback(repo => {
    const next = { owner: repo.owner, repo: repo.repo, branch: repo.defaultBranch || 'main' };
    setCurrent(next);
    setSubdir(repoPrefix(next));
    setPullBranch(next.branch);
    setSearch('');
    setLayer('');
    setErrorText('');
  }, [repoPrefix, setErrorText]);

  // 树：当前仓库前缀下的条目 = 本地副本 ∪ 清单（C1：快速检出后未物化的文件也
  // 在树上，带云朵角标；点开时按需下载）。本地存在的一律以本地为准。
  const { entries: repoEntries, virtual: virtualPaths } = useMemo(() => {
    if (!current) return { entries: [], virtual: new Set() };
    return mergeManifestEntries({ files: allFiles, manifestEntries, prefix: repoPrefix(current) });
  }, [allFiles, current, manifestEntries, repoPrefix]);

  const children = useMemo(() => directoryChildren(repoEntries, subdir), [repoEntries, subdir]);
  const crumbs = useMemo(() => breadcrumbsOf(subdir, t('workspace.panel.breadcrumb.root')), [subdir, t]);

  const repoId = current ? `${current.owner}/${current.repo}/${current.branch}` : '';

  // 载入该仓库的清单快照（拉取/推送成功时更新）——「待同步」的基线。
  useEffect(() => {
    let alive = true;
    if (!repoId) {
      setSnapshotPaths([]);
      return () => { alive = false; };
    }
    (async () => {
      try {
        const snapshot = await getRepoSnapshot(characterId, repoId);
        if (alive) setSnapshotPaths(snapshot && Array.isArray(snapshot.paths) ? snapshot.paths : []);
      } catch (error) {
        if (alive) setSnapshotPaths([]);
      }
    })();
    return () => { alive = false; };
  }, [characterId, repoId]);

  const diff = useMemo(
    () => diffRepoSnapshot({ files: allFiles, prefix: current ? repoPrefix(current) : '', snapshotPaths }),
    [allFiles, current, repoPrefix, snapshotPaths]
  );

  // C3 批量推送 / G1 确认门 / H3 回滚 / 一键交接的状态与动作已外提到 github/useRepoPush.js。
  const { pushBusy, markSynced, pushBatch, rollbackLastPush, handoffPush } = useRepoPush({
    characterId,
    storeRef,
    current,
    pullBranch,
    token,
    describeError,
    refreshLocal,
    mountedRef,
    t,
    onHandoff,
    diff,
    repoId,
    allFiles,
    repoPrefix,
    setSnapshotPaths,
    setRollbackInfo,
  });

  // 搜索：过滤当前仓库树的全部文件（本地副本全量路径匹配，不区分大小写）。
  // 文件树浏览域（搜索 / 打开文件 / 导入本地文件 / 新建条目）已外提到 github/useRepoFiles.js。
  const { searchResults, openFile, importLocalFiles, submitEntry } = useRepoFiles({
    characterId,
    storeRef,
    current,
    allFiles,
    subdir,
    search,
    entryForm,
    repoPrefix,
    refreshLocal,
    virtualPaths,
    token,
    mountedRef,
    t,
    setPreview,
    setLayer,
    setEntryForm,
    setActionBusy,
  });

  // 拉取当前仓库的分支快照到本地副本（codeload zipball → 文本文件落盘）。
  // 与 Stage 0 的修复同一条链路：目录条目已跳过、父路径被文件占用有明确报错、
  // 一次导入只记一条汇总历史（批内挂起逐文件记录）。带进度与取消（取消即回滚）。
  // C1 快速检出的状态与动作已外提到 github/useRepoBranch.js。

  // 拉取（重拉远端快照到本地副本）域：进度/ETA/前台提示、覆盖确认、跳过清单。
  // 状态与动作已外提到 github/useRepoPull.js。
  const {
    pullBusy,
    pullProgress,
    pullNotice,
    pullEta,
    pullCancelRef,
    skippedPayload,
    skippedOpen,
    setSkippedOpen,
    pullSnapshot,
  } = useRepoPull({
    characterId,
    storeRef,
    current,
    pullBranch,
    token,
    describeError,
    refreshLocal,
    mountedRef,
    t,
    setCurrent,
    setSubdir,
    setSnapshotPaths,
  });


  // ⑤ 新建仓库 / ⑥ 仓库管理（复制链接/重命名/删除）的状态与动作已外提到 github/useRepoManage.js。
  const {
    newRepo,
    setNewRepo,
    renameValue,
    setRenameValue,
    deleteConfirm,
    setDeleteConfirm,
    scopes,
    openManage,
    copyRepoLink,
    submitRename,
    submitDelete,
    submitCreateRepo,
  } = useRepoManage({
    characterId,
    storeRef,
    current,
    token,
    describeError,
    refreshLocal,
    mountedRef,
    t,
    selectRepo,
    setRepos,
    setCurrent,
    setSubdir,
    setLayer,
    setActionBusy,
  });

  // 推送/回滚/交接的状态与动作已外提到 github/useRepoPush.js。

  const canAct = Boolean(current) && Boolean(storeRef && storeRef.current);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.body}>
        {layer === 'preview' && preview ? (
          <>
            <TouchableOpacity style={styles.layerHeader} onPress={() => { setLayer(''); setPreview(null); }} activeOpacity={0.8}>
              <Ionicons name="chevron-back" size={18} color={theme.colors.text} />
              <Text style={styles.layerTitle} numberOfLines={1} ellipsizeMode="middle">{preview.path}</Text>
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
                    <Text style={styles.repoName} numberOfLines={1} ellipsizeMode="middle">{repo.fullName}</Text>
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
                        <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{path}</Text>
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
                            <Text style={[styles.crumbText, index === crumbs.length - 1 && styles.crumbTextActive]} numberOfLines={1} ellipsizeMode="middle">
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
                          <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{child.name}</Text>
                          {/* C1：只在清单里（未物化）的条目带云朵角标——点开时按需下载。 */}
                          {virtualPaths.has(child.path) ? (
                            <Ionicons
                              name="cloud-outline"
                              size={13}
                              color={theme.colors.textFaint}
                              style={styles.virtualBadge}
                            />
                          ) : null}
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                )}

                {current ? (
                  <TouchableOpacity
                    style={styles.checkoutRow}
                    onPress={quickCheckout}
                    activeOpacity={0.85}
                    disabled={checkoutBusy}
                  >
                    <Ionicons name="flash-outline" size={15} color={theme.colors.primary} />
                    <Text style={styles.checkoutText}>
                      {checkoutBusy
                        ? t('workspace.github.checkout.busy')
                        : t('workspace.github.checkout.action')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {manifestTruncated ? (
                  <FieldHint>{t('workspace.github.checkout.truncatedHint')}</FieldHint>
                ) : null}

                <View style={styles.pullRow}>
                  <TextInput
                    style={[styles.input, styles.branchInput]}
                    value={pullBranch}
                    onChangeText={setPullBranch}
                    placeholder={t('workspace.github.pull.branchPlaceholder')}
                    placeholderTextColor={theme.colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <PrimaryButton
                    title={pullBusy
                      ? (pullProgress.total > 0
                        ? t('workspace.github.pull.progress', { done: pullProgress.done, total: pullProgress.total })
                        : t('workspace.github.pull.busy'))
                      : t('workspace.github.pull.action')}
                    small
                    onPress={pullSnapshot}
                  />
                  {pullBusy ? (
                    <GhostButton
                      title={t('workspace.github.pull.cancel')}
                      small
                      onPress={() => { pullCancelRef.current = true; }}
                    />
                  ) : null}
                </View>
                {/* B1：分支 chip（点选即填输入框）。加载中 / 失败都有对应状态——
                    失败不阻塞：手动输入始终可用（特殊分支名与 >200 个分支的兜底）。 */}
                {branchBusy ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} style={styles.branchChipsBusy} />
                ) : branchError ? (
                  <FieldHint>{t('workspace.github.branch.loadError')}</FieldHint>
                ) : branchOptions.length > 0 ? (
                  <>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.branchChips}
                      contentContainerStyle={styles.branchChipsContent}
                    >
                      {branchOptions.map(item => (
                        <TouchableOpacity
                          key={item.name}
                          style={[styles.branchChip, item.name === pullBranch && styles.branchChipActive]}
                          onPress={() => setPullBranch(item.name)}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.branchChipText, item.name === pullBranch && styles.branchChipTextActive]}>
                            {item.name}
                          </Text>
                          {current && item.name === current.defaultBranch ? (
                            <View style={styles.branchChipBadge}>
                              <Text style={styles.branchChipBadgeText}>{t('workspace.github.branch.defaultTag')}</Text>
                            </View>
                          ) : null}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                    {branchOverLimit ? <FieldHint>{t('workspace.github.branch.overLimit')}</FieldHint> : null}
                  </>
                ) : null}
                {pullBusy ? (
                  <FieldHint>
                    {pullProgress.total > 0
                      ? t('workspace.github.pull.foreground', { eta: pullEta })
                      : t('workspace.github.pull.foregroundPreparing')}
                  </FieldHint>
                ) : null}
                {pullNotice ? <FieldHint>{pullNotice}</FieldHint> : null}
                {/* G2：跳过清单入口——「少了哪些文件」可见（以前只有计数）。 */}
                {skippedPayload && skippedPayload.total > 0 ? (
                  <>
                    <View style={styles.actions}>
                      <GhostButton
                        title={skippedOpen
                          ? t('workspace.github.skipped.hide')
                          : t('workspace.github.skipped.view', { count: skippedPayload.total })}
                        small
                        onPress={() => setSkippedOpen(value => !value)}
                      />
                    </View>
                    {skippedOpen ? (
                      <Text style={styles.skippedList} selectable numberOfLines={80}>
                        {formatSkippedList(skippedPayload)}
                      </Text>
                    ) : null}
                  </>
                ) : null}
                <FieldHint>{t('workspace.github.pull.hint')}</FieldHint>

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

            {layer === 'build' && current ? (
              <BuildSection
                styles={styles}
                theme={theme}
                t={t}
                buildWorkflow={buildWorkflow}
                setBuildWorkflow={setBuildWorkflow}
                buildBusy={buildBusy}
                buildRuns={buildRuns}
                buildLog={buildLog}
                buildNotice={buildNotice}
                branch={String(pullBranch || current.branch || '').trim()}
                onRefresh={refreshBuildRuns}
                onSubmit={submitBuild}
                onOpenLog={openBuildLog}
              />
            ) : null}

            {current ? (
              <View style={styles.formCard}>
                {/* E5：提交历史（内联展开）——点条目看截断后的 diff（大 diff 头尾都保）。 */}
                <View style={styles.actions}>
                  <GhostButton
                    title={historyOpen
                      ? t('workspace.github.history.hide')
                      : t('workspace.github.history.load')}
                    small
                    onPress={() => {
                      const next = !historyOpen;
                      setHistoryOpen(next);
                      if (next && historyCommits.length === 0) loadHistory(1, false);
                    }}
                  />
                </View>
                {historyOpen ? (
                  <>
                    {historyBusy && historyCommits.length === 0 ? (
                      <FieldHint>{t('workspace.github.history.loading')}</FieldHint>
                    ) : null}
                    {historyError ? <FieldHint>{t('workspace.github.history.err')}</FieldHint> : null}
                    {!historyBusy && !historyError && historyCommits.length === 0 ? (
                      <FieldHint>{t('workspace.github.history.empty')}</FieldHint>
                    ) : null}
                    {historyCommits.map(item => (
                      <TouchableOpacity
                        key={item.sha}
                        style={styles.manageRow}
                        onPress={() => openCommitDiff(item.sha)}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="git-commit-outline" size={16} color={theme.colors.primaryMuted} />
                        <Text style={styles.historyText} numberOfLines={1}>
                          {item.sha.slice(0, 7)} · {item.message}
                        </Text>
                        <Text style={styles.historyMeta}>{item.date.slice(0, 10)}</Text>
                      </TouchableOpacity>
                    ))}
                    {historyDiff ? (
                      <>
                        <FieldLabel>{`${historyDiff.sha.slice(0, 7)} diff`}</FieldLabel>
                        {/* H2：统一 diff 文本 → 行级着色（WebView；加载中/错误仍是纯文本行）。 */}
                        {historyDiff.loading
                          ? <Text style={styles.historyDiffText}>{historyDiff.text}</Text>
                          : (
                            <DiffView
                              unified={historyDiff.text}
                              title={historyDiff.sha.slice(0, 7)}
                              height={360}
                            />
                          )}
                      </>
                    ) : null}
                    {historyCommits.length >= 30 ? (
                      <View style={styles.actions}>
                        <GhostButton
                          title={t('workspace.github.history.more')}
                          small
                          onPress={() => loadHistory(historyPage + 1, true)}
                        />
                      </View>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}

            {current ? (
              <View style={styles.pushBar}>
                <Text style={styles.pushText}>
                  {diff.pending > 0
                    ? t('workspace.github.push.summary', {
                      added: diff.added.length,
                      removed: diff.removed.length,
                      total: diff.total,
                    })
                    : t('workspace.github.push.none')}
                </Text>
                <FieldHint>{t('workspace.github.push.contentNote')}</FieldHint>
                <View style={styles.actions}>
                  {/* C3：批量单提交是主路径（内容改动只有 blob sha 算得出，不看
                      diff.pending）；逐文件 handoff 降为精细模式的备选。 */}
                  <PrimaryButton
                    title={pushBusy ? t('workspace.github.push.batchBusy') : t('workspace.github.push.batch')}
                    small
                    onPress={pushBatch}
                  />
                  {diff.pending > 0 && typeof onHandoff === 'function' ? (
                    <GhostButton title={t('workspace.github.push.handoff')} small onPress={handoffPush} />
                  ) : null}
                  <GhostButton title={t('workspace.github.push.markSynced')} small onPress={markSynced} />
                  {/* E5：创建 PR（写操作——确认门在 submitCreatePr 内）。 */}
                  <GhostButton
                    title={prBusy ? t('workspace.github.pr.busy') : t('workspace.github.pr.action')}
                    small
                    onPress={submitCreatePr}
                  />
                  {/* H3：回滚最近一次推送（快照存在时可见）——恢复本地后走推送门同步远端。 */}
                  {rollbackInfo ? (
                    <GhostButton
                      title={t('workspace.github.rollback.action')}
                      small
                      onPress={rollbackLastPush}
                    />
                  ) : null}
                </View>
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
          <Ionicons name="list-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={importLocalFiles}
          disabled={!canAct || actionBusy === 'import'}
          accessibilityLabel={t('workspace.github.toolbar.importLocal')}
        >
          <Ionicons name="cloud-upload-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={() => { setEntryForm({ kind: 'text', name: '', content: '' }); setLayer('newEntry'); }}
          disabled={!canAct}
          accessibilityLabel={t('workspace.github.toolbar.newEntry')}
        >
          <Ionicons name="add-outline" size={21} color={theme.colors.accentText} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolButton}
          onPress={refreshAll}
          disabled={actionBusy === 'refresh'}
          accessibilityLabel={t('workspace.github.toolbar.refresh')}
        >
          <Ionicons name="refresh-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !token && styles.toolDisabled]}
          onPress={() => { setNewRepo({ name: '', description: '', isPrivate: true, autoInit: false }); setLayer('newRepo'); }}
          disabled={!token}
          accessibilityLabel={t('workspace.github.toolbar.createRepo')}
        >
          <Ionicons name="add-circle-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={openManage}
          disabled={!canAct}
          accessibilityLabel={t('workspace.github.toolbar.manage')}
        >
          <Ionicons name="options-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
        {/* H1：云构建（触发 → 看状态 → 读日志——「写→检查→修」闭环的远端重活）。 */}
        <TouchableOpacity
          style={[styles.toolButton, !canAct && styles.toolDisabled]}
          onPress={() => {
            const next = layer === 'build' ? '' : 'build';
            setLayer(next);
            setBuildLog(null);
            if (next) refreshBuildRuns();
          }}
          disabled={!canAct}
          accessibilityLabel={t('workspace.github.toolbar.build')}
        >
          <Ionicons name="cafe-outline" size={19} color={theme.colors.accentText} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

