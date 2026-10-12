import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { getRepoSnapshot, setRepoSnapshot } from '../../../storage/workspace.js';
import { localRepoPaths } from '../repoDiff.js';
import { pushRepoSnapshot } from '../../repoPush.js';
import {
  applyRollbackSnapshot,
  buildRollbackPayload,
  // 两线合并新增：不可恢复项的**清单**（含原因）在执行前列出，取代原先只给数量的版本。
  formatRollbackUnrestorableLines,
  readLatestRollbackSnapshot,
  rollbackUnrestorableReport,
  writeRollbackSnapshot,
} from '../../rollbackBaseline.js';

// 推送域：批量推送（Trees API 单提交）+ 确认门（删除安全网）+ 一键回滚 + 一键交接。
// 从 GithubPanel 原样搬出（行为不变）；基线/清单/仓库态由面板注入。
export default function useRepoPush({
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
}) {
  const [pushBusy, setPushBusy] = useState(false);

  // 把当前清单设为新基线（助手推送成功后，用户手动确认「已同步」）。
  const markSynced = useCallback(async () => {
    if (!current) return;
    const paths = localRepoPaths({ files: allFiles, prefix: repoPrefix(current) });
    try {
      await setRepoSnapshot(characterId, repoId, { paths });
      if (mountedRef.current) setSnapshotPaths(paths);
      Alert.alert(t('workspace.github.title'), t('workspace.github.push.markedSynced'));
    } catch (error) {}
  }, [allFiles, characterId, current, mountedRef, repoId, repoPrefix, setSnapshotPaths, t]);

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
  }, [characterId, confirmPushDiff, current, describeError, pullBranch, pushBusy, refreshLocal, storeRef, t, token, mountedRef, setSnapshotPaths, setRollbackInfo]);

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
    // ⚠️ 两线合并（2026-10-12）：此处**取 main 侧的详细版**，而非本提取分支原先的「只给数量」版。
    // main 的改动（D 线）把不可恢复项**在执行前列清楚** —— 只给数量等于让用户先点下去再吃结果；
    // 清单与原因词条键都由 rollbackBaseline 的纯函数算（`rollbackUnrestorableReport` /
    // `formatRollbackUnrestorableLines`），不复刻第二份文案逻辑。
    const lost = rollbackUnrestorableReport(payload);
    const lostNote = formatRollbackUnrestorableLines(lost, (key, params) => t(key, params), t('workspace.github.rollback.lostTitle'));
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
  }, [characterId, current, describeError, pushBusy, refreshLocal, storeRef, t, mountedRef, setRollbackInfo]);

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

  return { pushBusy, markSynced, pushBatch, rollbackLastPush, handoffPush };
}
