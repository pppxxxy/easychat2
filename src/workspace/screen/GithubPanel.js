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
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton } from '../../ui/index.js';
import DiffView from '../DiffView.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getGithubMcpSettings } from '../../storage/githubMcp.js';
import { getRepoSnapshot, setRepoSnapshot } from '../../storage/workspace.js';
import { isTextLike, readTextAttachment } from '../../chat/attachments.js';
import { ensureDirectoryName, ensureTextFileName } from '../naming.js';
import { breadcrumbsOf, directoryChildren, mergeManifestEntries } from '../screen/buildTree.js';
import { diffRepoSnapshot, localRepoPaths } from './repoDiff.js';
import { materializeRepoFile } from '../repoMaterialize.js';
import { pushRepoSnapshot } from '../repoPush.js';
import {
  applyRollbackSnapshot,
  buildRollbackPayload,
  listRollbackSnapshots,
  readLatestRollbackSnapshot,
  writeRollbackSnapshot,
} from '../rollbackBaseline.js';
import {
  formatSkippedList,
  readRepoManifest,
  writeRepoManifest,
} from '../repoImport.js';
import {
  canDeleteRepo,
  createRepo,
  deleteRepo,
  fetchTokenScopes,
  listBranches,
  listRepos,
  listTree,
  renameRepo,
  repoWebUrl,
} from '../github/restApi.js';
import createStyles from './githubPanelStyles.js';
import BuildSection from './github/BuildSection.js';
import useGithubBuild from './github/useGithubBuild.js';
import useGithubHistory from './github/useGithubHistory.js';
import useRepoPull from './github/useRepoPull.js';

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
  // 拉取快照（codeload zipball → 本地副本）：分支、进度、取消。
  const [pullBranch, setPullBranch] = useState('main');

  const [rollbackInfo, setRollbackInfo] = useState(null);
  // B1 分支选择器：三态（loading / error / chips）；seq 防「快速切仓库时旧响应
  // 后到」把新仓库的分支列表盖回去（网络乱序是常态，不能靠响应先后）。
  const [branchOptions, setBranchOptions] = useState([]);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState(false);
  const [branchOverLimit, setBranchOverLimit] = useState(false);
  const branchSeqRef = useRef(0);
  // C1 清单先行：快速检出的清单（1 次 API 出全树）+ 截断标记 + 检出中状态。
  const [manifestEntries, setManifestEntries] = useState([]);
  const [manifestTruncated, setManifestTruncated] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  // C3 批量推送（Trees API 单提交）进行中状态。
  const [pushBusy, setPushBusy] = useState(false);
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
    setPullBranch(next.branch);
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

  // C1：载入该仓库的清单缓存（快速检出写入；缺失 = 没做过快速检出，行为与旧版一致）。
  useEffect(() => {
    let alive = true;
    if (!current) {
      setManifestEntries([]);
      setManifestTruncated(false);
      return () => { alive = false; };
    }
    const store = storeRef && storeRef.current;
    (async () => {
      try {
        const manifest = await readRepoManifest(store, characterId, {
          owner: current.owner,
          repo: current.repo,
          branch: current.branch || current.defaultBranch,
        });
        if (!alive) return;
        setManifestEntries(manifest && Array.isArray(manifest.entries) ? manifest.entries : []);
        setManifestTruncated(Boolean(manifest && manifest.truncated));
      } catch (error) {
        if (alive) {
          setManifestEntries([]);
          setManifestTruncated(false);
        }
      }
    })();
    return () => { alive = false; };
  }, [characterId, current, storeRef]);

  // B1：选中仓库后拉分支列表（最多 2 页 = 200 个；超过只提示手动输入）。
  // 失败不阻塞——输入框始终可用（清单三态里的「失败」就是一行提示）。
  useEffect(() => {
    const owner = current ? current.owner : '';
    const repo = current ? current.repo : '';
    branchSeqRef.current += 1;
    const seq = branchSeqRef.current;
    if (!owner || !repo) {
      setBranchOptions([]);
      setBranchBusy(false);
      setBranchError(false);
      setBranchOverLimit(false);
      return undefined;
    }
    let alive = true;
    setBranchBusy(true);
    setBranchError(false);
    setBranchOverLimit(false);
    setBranchOptions([]);
    (async () => {
      try {
        const first = await listBranches({ token, owner, repo });
        let names = first;
        let over = false;
        if (first.length >= 100) {
          const second = await listBranches({ token, owner, repo, page: 2 });
          names = [...first, ...second];
          over = second.length >= 100;
        }
        if (!alive || branchSeqRef.current !== seq) return;
        setBranchOptions(names.map(name => ({ name })));
        setBranchOverLimit(over);
      } catch (error) {
        if (!alive || branchSeqRef.current !== seq) return;
        setBranchError(true);
      } finally {
        if (alive && branchSeqRef.current === seq) setBranchBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [current, token]);

  // B2：分支输入框与该仓库的真实默认分支对齐（normalizeRepo.defaultBranch——
  // 硬编码 'main' 会让默认分支叫 develop 的仓库直接 404）。已拉取过的仓库
  // （current.branch 有值 = 当前本地副本的分支）优先它，别把用户切过的分支
  // 重置回默认；换仓库时同步重置，不带旧分支名。
  useEffect(() => {
    const initial = String((current && (current.branch || current.defaultBranch)) || '').trim();
    setPullBranch(initial || 'main');
  }, [current]);

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
      // C2：清单里存在但本地没物化 → 点开即拉（单文件 contents API），拉完重读。
      // 明确失败（网络/超过单文件上限）时如实报——绝不静默停在打不开的状态。
      if (virtualPaths.has(path)) {
        try {
          const materialized = await materializeRepoFile({ store, characterId, path, token });
          if (materialized.ok) {
            const result = await store.readWorkspaceFile({ characterId, path });
            if (mountedRef.current) {
              setPreview(result);
              setLayer('preview');
            }
            await refreshLocal();
            return;
          }
          Alert.alert(
            t('workspace.github.title'),
            materialized.reason === 'none'
              ? t('workspace.github.materialize.tooLarge')
              : t('workspace.github.materialize.fail')
          );
          return;
        } catch (error) {
          Alert.alert(t('workspace.github.title'), t('workspace.github.materialize.fail'));
          return;
        }
      }
      Alert.alert(t('workspace.github.title'), t('workspace.github.err.open'));
    }
  }, [characterId, refreshLocal, storeRef, t, token, virtualPaths]);

  // 拉取当前仓库的分支快照到本地副本（codeload zipball → 文本文件落盘）。
  // 与 Stage 0 的修复同一条链路：目录条目已跳过、父路径被文件占用有明确报错、
  // 一次导入只记一条汇总历史（批内挂起逐文件记录）。带进度与取消（取消即回滚）。
  // C1 快速检出：1 次 Trees API 秒开全树——清单落盘缓存、树立即可见（未物化
  // 文件带云朵角标），并把清单设为「已同步」基线（与完整拉取同语义：远程已有）。
  // 之后要么按需物化（点开即拉），要么随时「拉取快照」批量落盘。
  const quickCheckout = useCallback(async () => {
    if (!current || checkoutBusy) return;
    const store = storeRef && storeRef.current;
    if (!store) return;
    const branch = String(pullBranch || current.branch || current.defaultBranch || '').trim();
    if (!branch) return;
    setCheckoutBusy(true);
    try {
      const { entries, truncated } = await listTree({
        token,
        owner: current.owner,
        repo: current.repo,
        ref: branch,
      });
      if (entries.length === 0) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.pull.noFiles'));
        return;
      }
      await writeRepoManifest(store, characterId, {
        owner: current.owner,
        repo: current.repo,
        branch,
      }, { entries, truncated });
      if (mountedRef.current) {
        setManifestEntries(entries);
        setManifestTruncated(truncated);
        setCurrent(prev => (prev ? { ...prev, branch } : prev));
        setSubdir(`repos/${current.owner}/${current.repo}/${branch}/`);
      }
      // 基线 = 清单里的文件（「已同步」语义与完整拉取一致：远程已存在这些文件）。
      try {
        const paths = entries.filter(item => item.type !== 'tree').map(item => item.path);
        await setRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`, { paths });
        if (mountedRef.current) setSnapshotPaths(paths);
      } catch (error) {}
      if (truncated && mountedRef.current) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.checkout.truncated'));
      }
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setCheckoutBusy(false);
    }
  }, [characterId, checkoutBusy, current, describeError, pullBranch, storeRef, t, token]);

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
      // 本地副本目录同步改名（repos/<owner>/<旧名> → repos/<owner>/<新名>）。
      // 失败不阻断重命名（远端已改成功），只如实告知本地目录没跟着动。
      const store = storeRef && storeRef.current;
      let movedLocal = false;
      if (store && typeof store.moveWorkspaceDirectory === 'function') {
        try {
          const moved = await store.moveWorkspaceDirectory({
            characterId,
            from: `repos/${current.owner}/${current.repo}`,
            to: `repos/${updated.owner}/${updated.repo}`,
          });
          movedLocal = Boolean(moved && moved.moved);
        } catch (error) {
          movedLocal = false;
        }
      }
      if (mountedRef.current) {
        setRepos(prev => prev.map(item => (item.fullName === `${current.owner}/${current.repo}` ? updated : item)));
        setCurrent({ owner: updated.owner, repo: updated.repo, branch });
        setSubdir(`repos/${updated.owner}/${updated.repo}/${branch}/`);
        setLayer('');
      }
      await refreshLocal();
      Alert.alert(t('workspace.github.title'), t(
        movedLocal ? 'workspace.github.manage.renamedAndMoved' : 'workspace.github.manage.renamed'
      ));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, describeError, refreshLocal, renameValue, storeRef, t, token]);

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

  // 把当前清单设为新基线（助手推送成功后，用户手动确认「已同步」）。
  const markSynced = useCallback(async () => {
    if (!current) return;
    const paths = localRepoPaths({ files: allFiles, prefix: repoPrefix(current) });
    try {
      await setRepoSnapshot(characterId, repoId, { paths });
      if (mountedRef.current) setSnapshotPaths(paths);
      Alert.alert(t('workspace.github.title'), t('workspace.github.push.markedSynced'));
    } catch (error) {}
  }, [allFiles, characterId, current, repoId, repoPrefix, t]);

  // 一键交接：把「哪个仓库/分支、增删了哪些文件」写成一条指令，填进对话面板的输入框，
  // 由助手用 GitHub 工具逐条确认后提交（本面板不做直连推送，写远端一律经确认）。
  // C3：一次确认框（三态计数 + 前几条清单）。Promise 化——**问不到用户 = 不推送**，
  // 与覆盖守卫/工具审批同款原则；点外部/返回键按取消。
  //
  // G1 可见性补全（2026-10-10）：删除是**不可逆**的，所以确认框必须把四件事说清：
  // ① 删除条目的完整清单（前 N 条 + 总条数，不只给个数字）；
  // ② 「永久删除、本地无备份」的警示（只说「删除 3 个」，用户不会意识到不可恢复）；
  // ③ 远程有而本地未物化的文件**本次保持原样**（不给这行，用户会把「没看到」
  //    误当成「它不在了」）；④ 无基线时明说「本次不执行删除」——否则用户分不清
  //    「没有要删的」与「因为没基线所以不删」，会把安全当常态。
  // 删除量超过「有资格删除的路径总数」一半时再问一次（异常放大信号：误判通常成片）。
  const confirmPushDiff = useCallback(({ added, modified, removed, remoteOnly = [], knownRemoteCount = 0 }, baselineMissing = false) => {
    const preview = [
      ...added.map(item => `+ ${item}`),
      ...modified.map(item => `~ ${item}`),
      ...removed.map(item => `- ${item}`),
    ];
    const listing = preview.slice(0, 12).join('\n') + (preview.length > 12 ? '\n…' : '');
    const extraLines = [];
    if (removed.length > 0) extraLines.push(t('workspace.github.push.confirmDeleteWarn', { count: removed.length }));
    if (remoteOnly.length > 0) extraLines.push(t('workspace.github.push.confirmRemoteOnly', { count: remoteOnly.length }));
    if (baselineMissing) extraLines.push(t('workspace.github.push.confirmNoBaseline'));
    const message = `${t('workspace.github.push.confirmBody', {
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      list: listing,
    })}${extraLines.length ? `\n\n${extraLines.join('\n')}` : ''}`;
    const askOnce = (title, body) => new Promise(resolve => {
      Alert.alert(title, body, [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('workspace.github.push.confirmAction'), style: 'destructive', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
    return askOnce(t('workspace.github.push.confirmTitle'), message).then(ok => {
      if (!ok) return false;
      // 异常放大：删除量 > 有资格删除总数的一半 → 再确认一次（误判通常成片出现，
      // 例如「拉取时跳过的文件」这类系统性问题；单条手动删除不会触发）。
      const alarming = removed.length > 0 && knownRemoteCount > 0 && removed.length * 2 > knownRemoteCount;
      if (!alarming) return true;
      return askOnce(
        t('workspace.github.push.confirmAlarmTitle'),
        t('workspace.github.push.confirmAlarmBody', {
          removed: removed.length,
          known: knownRemoteCount,
        })
      );
    });
  }, [t]);

  // C3 批量推送：本地副本 vs 远程树（git blob sha 判内容）→ 一次确认 → 单次原子
  // 提交（Trees API 四步）。与 handoffPush（逐文件、agent 走 MCP）并存——这里是
  // 面板直连 restApi 的快路径。ref 冲突（期间远程被推进）由 GitHub 非快进拒绝，安全失败。
  const pushBatch = useCallback(async () => {
    if (!current || pushBusy) return;
    const store = storeRef && storeRef.current;
    if (!store) return;
    const branch = String(pullBranch || current.branch || current.defaultBranch || '').trim();
    if (!branch) return;
    setPushBusy(true);
    try {
      // G1：读基线快照（拉取/推送成功后的清单）——「曾经物化过」的证据。
      // 基线缺失（旧会话/手工拷入）→ 传空数组：removed 恒空，宁可少删不可误删。
      let baselinePaths = [];
      try {
        const baseline = await getRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`);
        baselinePaths = baseline && Array.isArray(baseline.paths) ? baseline.paths : [];
      } catch (error) {}
      const result = await pushRepoSnapshot({
        store,
        characterId,
        owner: current.owner,
        repo: current.repo,
        branch,
        token,
        baselinePaths,
        confirm: ({ diff: guardDiff, baselineMissing }) => confirmPushDiff(guardDiff, baselineMissing),
      });
      if (result.empty) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.push.nothing'));
        return;
      }
      if (result.cancelled) return;
      if (result.ok === false && result.reason === 'truncated') {
        Alert.alert(t('workspace.github.title'), t('workspace.github.push.truncated'));
        return;
      }
      // 推送成功：远程 = 本地 → 基线刷新为本地当前清单（与拉取成功后同语义）。
      try {
        const list = await store.listWorkspaceFiles({ characterId });
        const prefix = `repos/${current.owner}/${current.repo}/${branch}/`;
        const paths = localRepoPaths({ files: list, prefix });
        await setRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`, { paths });
        if (mountedRef.current) setSnapshotPaths(paths);
      } catch (error) {}
      await refreshLocal();
      // H3：写回滚基线（本次 modified/removed 的远程旧内容）——push 前已拉好，
      // 这里落盘 + 轮换（保留 3 份）。写失败静默（旁路：没有快照只是不能回滚）。
      if (result.rollback) {
        const payload = buildRollbackPayload({
          owner: current.owner,
          repo: current.repo,
          branch,
          commit: result.commit,
          rollback: result.rollback,
        });
        const snapshotPath = await writeRollbackSnapshot(store, characterId, payload);
        if (snapshotPath && mountedRef.current) {
          setRollbackInfo({ at: payload.at });
        }
      }
      // G 系：读不全的超大文件**不参与本次同步**（保持原样，不会被误删）——如实提示。
      const skippedNote = Array.isArray(result.skippedTooLarge) && result.skippedTooLarge.length > 0
        ? `\n\n${t('workspace.github.push.skippedTooLarge', { count: result.skippedTooLarge.length })}`
        : '';
      Alert.alert(t('workspace.github.title'), t('workspace.github.push.doneBody', {
        sha: String(result.commit || '').slice(0, 7),
        added: result.diff.added.length,
        modified: result.diff.modified.length,
        removed: result.diff.removed.length,
      }) + skippedNote);
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setPushBusy(false);
    }
  }, [characterId, confirmPushDiff, current, describeError, pullBranch, pushBusy, refreshLocal, storeRef, t, token]);

  // H3：一键回滚——把本地恢复到最近一次推送之前（modified 写回旧内容 /
  // removed 恢复文件），再让用户走既有推送确认门同步到远端（不自动弹，避免连环弹窗）。
  const rollbackLastPush = useCallback(async () => {
    if (!current || pushBusy) return;
    const store = storeRef && storeRef.current;
    if (!store) return;
    const payload = await readLatestRollbackSnapshot(store, characterId);
    if (!payload) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.rollback.none'));
      if (mountedRef.current) setRollbackInfo(null);
      return;
    }
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const restorableCount = entries.filter(item => typeof item.content === 'string').length;
    const lostCount = entries.length - restorableCount;
    const lostNote = lostCount > 0
      ? `\n\n${t('workspace.github.rollback.lostNote', { count: lostCount })}`
      : '';
    Alert.alert(
      t('workspace.github.rollback.confirmTitle'),
      t('workspace.github.rollback.confirmBody', {
        count: restorableCount,
        time: new Date(payload.at || Date.now()).toLocaleString(),
      }) + lostNote,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('workspace.github.rollback.confirmAction'),
          style: 'destructive',
          onPress: async () => {
            try {
              const localPrefix = `repos/${payload.owner}/${payload.repo}/${payload.branch}/`;
              const outcome = await applyRollbackSnapshot({
                store,
                characterId,
                payload,
                localPrefix,
              });
              await refreshLocal();
              if (!mountedRef.current) return;
              Alert.alert(t('workspace.github.title'), t('workspace.github.rollback.done', {
                restored: outcome.restored.length,
                failed: outcome.failed.length + outcome.unrestorable.length,
              }));
            } catch (caught) {
              Alert.alert(t('workspace.github.title'), describeError(caught));
            }
          },
        },
      ]
    );
  }, [characterId, current, describeError, pushBusy, refreshLocal, storeRef, t]);

  const handoffPush = useCallback(() => {
    if (!current || typeof onHandoff !== 'function') return;
    const parts = [t('workspace.github.push.instructionHead', {
      owner: current.owner, repo: current.repo, branch: current.branch,
    })];
    if (diff.added.length) {
      parts.push(t('workspace.github.push.instructionAdded', {
        count: diff.added.length,
        list: diff.added.slice(0, 50).join('\n'),
      }));
    }
    if (diff.removed.length) {
      parts.push(t('workspace.github.push.instructionRemoved', {
        count: diff.removed.length,
        list: diff.removed.slice(0, 50).join('\n'),
      }));
    }
    parts.push(t('workspace.github.push.instructionTail'));
    onHandoff(parts.join('\n\n'));
  }, [current, diff, onHandoff, t]);

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

