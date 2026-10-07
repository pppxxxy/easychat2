// 本地模型面板的反馈映射（从壳抽出，让壳只做「组合 hooks + 渲染 + 反馈接线」）。
//
// 各域 hook 一律返回 { ok, code, message } 编码结果、自己不弹 Alert；这里把编码结果
// 统一翻成用户可见的 Alert。文案全走 t()——i18n 全量清理后壳里已无硬编码中文，
// 抽出后 src/LocalModelPanel.js 可以从 no-hardcoded-chinese 豁免清单移除了。
//
// 依赖显式注入（models/acquire/api 等由壳传入）而不是各自 new：删除链与参数保存要
// 读写壳持有的同一份 hook 实例状态，注入能保证「只有一份状态」。

import { Alert, Platform } from 'react-native';

import { deleteLocalModelItem, getLocalModelItem, saveLocalModelItem } from '../../storage.js';
import { deleteLocalModel } from '../modelManager.js';
import { isLocalModelLoaded, unloadLocalModel } from '../adapter.js';
import { stopLocalApiServer } from '../localApiServer.js';
import { clearActiveLocalModel } from '../modelState.js';
import { normalizeLocalModelParams, validateLocalModelParams } from '../modelParams.js';
import { PARAM_LABEL_KEYS } from './panelShared.js';
import { formatBytes } from '../../utils/format.js';

// Android 点弹窗外部即可关闭（iOS 不受 cancelable 参数影响）：系统习惯是点外
// 取消，误触长按/弹窗后不至于被「参数/删除」两个选项堵死（2026-10-07 修复）。
// 破坏性确认弹窗点外 = 取消，不会误触发删除。本模块所有弹窗统一走这里。
const alertCancelable = (title, message, buttons) => {
  Alert.alert(title, message, buttons, { cancelable: true, onDismiss: () => {} });
};

export function createPanelFeedback({
  t,
  models,
  acquire,
  api,
  updateSettings,
  refresh,
  onEditParams,
}) {
  const saveHint = t('localModel.alert.saveFailed.body');
  const { setApiStatus } = api;

  const onSelectActive = async entry => {
    const result = await models.selectActive(entry);
    if (result.ok) return;
    if (result.code === 'MODEL_ITEM_MISSING') alertCancelable(t('localModel.alert.paramsUnavailable.title'), t('localModel.alert.paramsUnavailable.body'));
    else if (result.code === 'MODEL_FILE_MISSING') alertCancelable(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.fileMissing'));
    else alertCancelable(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onToggleEnabled = async () => {
    const result = await models.toggleEnabled();
    if (result.ok) return;
    if (result.code === 'NO_MODEL_SELECTED') alertCancelable(t('localModel.alert.noModelSelected.title'), t('localModel.alert.noModelSelected.body'));
    else if (result.code === 'MODEL_FILE_MISSING') alertCancelable(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.downloadFirst'));
    else if (result.code !== 'NO_SETTINGS') alertCancelable(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onToggleMediaInput = async () => {
    const result = await models.toggleMediaInput();
    if (!result.ok && result.code !== 'NO_SETTINGS') alertCancelable(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onLoadModel = async entry => {
    const result = await models.handleLoadModel(entry);
    if (result.ok) {
      alertCancelable(t('localModel.alert.modelLoaded.title'), t('localModel.alert.modelLoaded.body'));
      return;
    }
    if (result.code === 'RESOURCE_BUSY') alertCancelable(t('localModel.alert.resourceBusy.title'), t('localModel.alert.resourceBusy.body'));
    else if (result.code === 'MODEL_ITEM_MISSING') alertCancelable(t('localModel.alert.loadFailed.title'), t('localModel.error.itemMissing'));
    else if (result.code === 'MODEL_FILE_MISSING') alertCancelable(t('localModel.alert.loadFailed.title'), t('localModel.error.fileMissing'));
    else alertCancelable(t('localModel.alert.loadFailed.title'), (result && result.message) || t('localModel.alert.loadFailed.body'));
  };

  const onCleanupOrphans = async () => {
    const result = await models.handleCleanupOrphans();
    if (!result.ok) {
      alertCancelable(t('localModel.alert.cleanupFailed.title'), (result && result.message) || t('localModel.alert.cleanupFailed.body'));
      return;
    }
    if (result.removed === 0) alertCancelable(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.empty'));
    else alertCancelable(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.body', { count: result.removed, size: formatBytes(result.freedBytes) || '0B' }));
  };

  const onDownload = async () => {
    const result = await acquire.handleDownload();
    if (result.ok) alertCancelable(t('localModel.alert.downloadDone.title'), t('localModel.alert.downloadDone.body', { name: result.name }));
    else if (result.code === 'INCOMPLETE_INPUT') alertCancelable(t('localModel.alert.downloadInfoIncomplete.title'), t('localModel.alert.downloadInfoIncomplete.body'));
    else if (result.code === 'CANCELLED') {
      // 用户主动取消不是失败：半成品已由 modelManager 的失败清理路径删除，不弹错误。
    } else alertCancelable(t('localModel.alert.downloadFailed.title'), (result && result.message) || t('localModel.alert.downloadFailed.body'));
  };

  const onPick = pickResult => {
    if (!pickResult.ok && pickResult.code === 'PICK_FAILED') {
      alertCancelable(t('localModel.alert.pickFileFailed.title'), (pickResult && pickResult.message) || t('localModel.alert.pickFileFailed.body'));
    }
  };

  const onImport = async () => {
    const result = await acquire.handleImport();
    if (result.ok) alertCancelable(t('localModel.alert.importDone.title'), t('localModel.alert.importDone.body', { name: result.name }));
    else if (result.code === 'NO_FILE') alertCancelable(t('localModel.alert.noFileSelected.title'), t('localModel.alert.noFileSelected.body'));
    else alertCancelable(t('localModel.alert.importFailed.title'), (result && result.message) || t('localModel.alert.importFailed.body'));
  };

  // 选中文件后静默回填（U5）：只有「跑不了」档弹一条警示，其余信息由 summaryCard 常驻。
  const onSearchSelect = selection => {
    const summary = acquire.handleSearchSelect(selection);
    if (!summary || summary.compatibility.tier !== 'incompatible') return;
    const memText = summary.memory.totalBytes > 0
      ? t('localModel.alert.preDownload.memory', { size: formatBytes(summary.memory.totalBytes) })
      : t('localModel.alert.preDownload.memoryUnknown');
    alertCancelable(
      t('localModel.alert.preDownload.title'),
      `${t('localModel.alert.preDownload.tier', { tier: summary.compatibility.label })}${memText}`
    );
  };

  const onStartApi = async () => {
    const result = await api.startApi();
    if (result.ok) {
      if (result.generatedKey) {
        alertCancelable(t('localModel.alert.apiKeyGenerated.title'), t('localModel.alert.apiKeyGenerated.body', { key: result.generatedKey }));
      }
      return;
    }
    if (result.code === 'UNAVAILABLE') alertCancelable(t('localModel.alert.apiUnavailable.title'), t('localModel.alert.apiUnavailable.body'));
    else if (result.code === 'START_FAILED') alertCancelable(t('localModel.alert.apiStartFailed.title'), (result && result.message) || t('localModel.alert.apiStartFailed.body'));
  };

  const onStopApi = async () => {
    const result = await api.stopApi();
    if (!result.ok && result.code === 'STOP_FAILED') alertCancelable(t('localModel.alert.apiStopFailed.title'), (result && result.message) || t('localModel.alert.apiStopFailed.body'));
  };

  const onCopyAddress = async () => {
    const result = await api.copyApiAddress();
    if (result.ok) {
      alertCancelable(t('localModel.alert.addressCopied.title'), t('localModel.alert.addressCopied.body', { address: api.apiAddress }));
    } else {
      alertCancelable(t('localModel.alert.copyFailed.title'), t('localModel.alert.copyFailed.body', { address: api.apiAddress }));
    }
  };

  // ---- 跨域组合：删除链（C4：判加载→停服务→卸载→（失败中止）→删文件→删登记）----
  const confirmDelete = entry => {
    alertCancelable(t('localModel.alert.deleteModel.title'), t('localModel.alert.deleteModel.body', { name: entry.name || entry.id }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const item = await getLocalModelItem(entry.id).catch(() => null);
          const wasActive = Boolean(models.settings && models.settings.activeModelId === entry.id);
          const wasLoaded = item ? isLocalModelLoaded(item) : false;
          // API 服务复用当前加载的上下文：被删模型已加载时，无论它是不是「当前选用」，
          // 都得先停服务再卸载，否则服务端口背后指向一个即将删除的文件。
          if ((wasActive || wasLoaded) && api.apiStatus.running) await stopLocalApiServer().catch(() => {});
          if (wasLoaded) {
            const released = await unloadLocalModel().catch(() => false);
            if (released === false) {
              alertCancelable(t('localModel.alert.unloadFailed.title'), t('localModel.alert.unloadFailed.body'));
              return;
            }
          }
          if (models.loadedModelId === entry.id) models.setLoadedModelId('');
          if (item) await deleteLocalModel(item).catch(() => {});
          await deleteLocalModelItem(entry.id).catch(() => {});
          if (wasActive) {
            try {
              await updateSettings(base => clearActiveLocalModel(base));
            } catch (error) {
              alertCancelable(t('localModel.alert.saveFailed.title'), saveHint);
            }
            setApiStatus({ running: false, port: 0 });
          }
          await refresh();
        },
      },
    ]);
  };

  // 长按操作单（U6）：参数/删除收进来，来源信息进副标题。
  const onEntryActions = entry => {
    const buttons = [
      { text: t('localModel.params'), onPress: () => onEditParams(entry) },
      { text: t('common.delete'), style: 'destructive', onPress: () => confirmDelete(entry) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: t('common.cancel'), style: 'cancel' });
    alertCancelable(entry.name || entry.id, entry.imported ? t('localModel.chip.imported') : t('localModel.download.section'), buttons);
  };

  return {
    onSelectActive,
    onToggleEnabled,
    onToggleMediaInput,
    onLoadModel,
    onCleanupOrphans,
    onDownload,
    onPick,
    onImport,
    onSearchSelect,
    onStartApi,
    onStopApi,
    onCopyAddress,
    confirmDelete,
    onEntryActions,
  };
}

// 参数弹窗的保存动作（弹窗状态在 useModelParams 里，这里只处理校验/落盘/反馈）。
export function createParamsSaver({ t, settings, updateSettings, refresh }) {
  return async function saveParams(target, form) {
    const check = validateLocalModelParams(form);
    if (!check.valid) {
      alertCancelable(
        t('localModel.alert.paramsInvalid.title'),
        check.errors.map(item => `${t(PARAM_LABEL_KEYS[item.field] || '') || item.field}：${item.message}`).join('\n')
      );
      return { ok: false, code: 'INVALID' };
    }
    try {
      const saved = await saveLocalModelItem({ ...target, params: normalizeLocalModelParams(form) });
      if (settings && settings.activeModelId === saved.id) {
        await updateSettings(base => ({
          ...base,
          contextSize: saved.params.contextSize,
          gpuLayers: saved.params.gpuLayers,
        }));
      }
      await refresh();
      return { ok: true, saved };
    } catch (error) {
      alertCancelable(t('localModel.alert.saveFailed.title'), error.message || t('localModel.alert.saveFailed.retry'));
      return { ok: false, code: 'SAVE_FAILED' };
    }
  };
}
