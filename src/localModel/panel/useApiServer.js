// 服务域：本地 API 服务（OpenAI 兼容）的端口/密钥编辑态、启停与状态轮询。
// 端口在编辑态统一存 string（C6），落盘时 parseInt（非法回退 8080，与存储层
// normalizeLocalModelApiServer 口径一致），读回后再转 string 回填编辑态。
// 反馈约定同其余 hooks：返回 { ok, code, ... }，由壳映射成用户可见文案。

import { useCallback, useMemo, useState } from 'react';

import * as Clipboard from 'expo-clipboard';

import { tActive } from '../../i18n/index.js';
import { getLocalModelIndex, getLocalModelSettingsStatus } from '../../storage/localModels.js';
import {
  getLocalApiServerStatus,
  isLocalApiServerAvailable,
  startLocalApiServer,
  stopLocalApiServer,
} from '../localApiServer.js';

// 启动前置判据（纯函数，B3）：只有「确认读到设置（ok）」或「设置键确实不存在（missing）」
// 才允许把空密钥当成「需要生成」。corrupt / 读失败意味着凭据处于**未知**态 —— 此时生成
// 新密钥就是整键覆盖用户原有密钥：任何已按旧密钥配置的外部客户端全部 401，且旧密钥不可
// 恢复（用户也看不出这是一次「覆盖」而非「首次生成」）。未知态一律 fail-closed。
// 先例：同面板 usePanelModels.updateSettings 已建立 fail-closed 口径（读失败即抛错、不写回）；
// 本仓反面教材见 storage/localModels.js:getLocalModelSettingsStatus 的注释。
export function resolveApiKeyState({ settingsStatus, currentKey = '' } = {}) {
  if (settingsStatus !== 'ok' && settingsStatus !== 'missing') {
    return { allowed: false, keyWasEmpty: false };
  }
  return { allowed: true, keyWasEmpty: !String(currentKey || '').trim() };
}

// 启动流程（IO 全部注入，便于在 Node 下直测 B2/B3）。
//
// ⚠️ 顺序本身就是修复（B2）：**先启动、后落盘**。
// 旧顺序「先 persist({enabled:true}) 再原生 start」在端口被占用（最常见的启动失败原因）
// 时会把 enabled:true 留在盘上：重启后 UI 显示「已启用」而服务从未运行，apiAddress 还
// 展示一个不可达的地址让用户复制。延后到启动成功之后再写，就不存在「需要回滚的残留」；
// 而 commit 失败时停掉刚启动的服务，维持「盘上的 enabled ⇔ 服务真的在跑」这一不变量
// （对照 storage/localModels.js:saveLocalModelItem 的「任一步失败都回滚」）。
export async function runApiServerStart({
  port,
  apiKey = '',
  loadSettingsStatus,
  loadModels,
  start,
  commit,
  stop = async () => {},
}) {
  // ① 凭据前置：设置读不出来 ⇒ 密钥未知 ⇒ 不生成、不启动（B3）。
  const stored = await loadSettingsStatus();
  const plan = resolveApiKeyState({ settingsStatus: stored && stored.status, currentKey: apiKey });
  if (!plan.allowed) return { ok: false, code: 'START_FAILED', reason: 'SETTINGS_UNREADABLE' };
  const settings = (stored && stored.settings) || null;

  // ② 先启动（v5 Stage D：已安装模型列表下发原生，/v1/models 才能全量返回）。
  let started;
  try {
    started = await start({
      port: Number(port) || 8080,
      apiKey,
      modelId: (settings && settings.activeModelId) || 'local-model',
      models: await loadModels().catch(() => []),
    });
  } catch (error) {
    // 启动失败：盘上没有任何「已启用」的残留，重启后 UI 与服务状态天然一致。
    return { ok: false, code: 'START_FAILED', message: error && error.message };
  }

  // ③ 启动成功后才落盘 enabled:true（提交点）。
  const effectiveKey = String((started && started.apiKey) || apiKey || '');
  try {
    await commit({ keyWasEmpty: plan.keyWasEmpty, effectiveKey });
  } catch (error) {
    // 记不下来就别让它跑：否则出现反向不一致（服务在跑、盘上说没启用），
    // 且「生成的密钥没落盘」会让下次重启后客户端用错密钥（401）。
    await stop().catch(() => {});
    return { ok: false, code: 'START_FAILED', message: error && error.message };
  }

  return {
    ok: true,
    keyWasEmpty: plan.keyWasEmpty,
    effectiveKey,
    port: Number(started && started.port) || Number(port) || 8080,
  };
}

export function useApiServer({ updateSettings }) {
  const [apiServer, setApiServer] = useState({ enabled: false, host: '127.0.0.1', port: '8080', apiKey: '' });
  const [apiStatus, setApiStatus] = useState({ running: false, port: 0 });
  const [apiBusy, setApiBusy] = useState(false);
  // B3：设置是否**确认读到过**。null=未水合；true=读到；false=读失败（凭据未知）。
  // 密钥停留在 '' 时，「未知」与「确实为空」绝不是一回事，所以单独记一态。
  const [apiSettingsLoaded, setApiSettingsLoaded] = useState(null);

  // 打开面板时的全量水合（C7）：只有这里允许用存储值回填编辑态；
  // 操作后的 refresh 绝不碰本域，否则用户正在输入的端口/密钥会被打回。
  const hydrate = useCallback(async () => {
    const [stored, status] = await Promise.all([
      // 三态读（B3）：corrupt 时 settings 为 null。旧写法 getLocalModelSettings().catch(() => null)
      // 看似安全，实则上游 readJson 已把读失败吞成默认设置，.catch 几乎永不触发。
      getLocalModelSettingsStatus().catch(() => ({ status: 'corrupt', settings: null })),
      getLocalApiServerStatus().catch(() => ({ running: false, port: 0 })),
    ]);
    const current = stored && stored.settings;
    if (current && current.apiServer) {
      setApiServer({ ...current.apiServer, port: String(current.apiServer.port || '') });
    }
    // 读失败时不回填（编辑态保持原样），并把该域标记为「未知」：startApi 据此拒绝启动，
    // 绝不在未知状态下生成并覆盖用户凭据。
    setApiSettingsLoaded(Boolean(current && current.apiServer));
    setApiStatus({ running: Boolean(status && status.running), port: Number(status && status.port) || 0 });
  }, []);

  const persistApiServer = useCallback(async patch => {
    const parsedPort = Math.trunc(Number(apiServer.port));
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
    // updateSettings 内部重读最新设置再合并（C3），enabled/apiKey 不会互相覆盖。
    const next = await updateSettings(base => ({
      ...base,
      apiServer: { ...apiServer, ...patch, port },
    }));
    setApiServer({ ...(next.apiServer || apiServer), port: String((next.apiServer && next.apiServer.port) || port) });
    return next;
  }, [apiServer, updateSettings]);

  const startApi = useCallback(async () => {
    if (apiBusy) return { ok: false, code: 'BUSY' };
    if (!isLocalApiServerAvailable()) return { ok: false, code: 'UNAVAILABLE' };
    setApiBusy(true);
    try {
      const parsedPort = Math.trunc(Number(apiServer.port));
      const result = await runApiServerStart({
        port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080,
        apiKey: apiServer.apiKey,
        loadSettingsStatus: getLocalModelSettingsStatus,
        loadModels: () => getLocalModelIndex(),
        start: startLocalApiServer,
        stop: stopLocalApiServer,
        // 提交点：只有原生启动成功才会被调用（B2）。留空即自动生成随机密钥，
        // 生成后持久化，重启不变；keyWasEmpty 为假时只记 enabled，不碰用户已有密钥。
        commit: async ({ keyWasEmpty, effectiveKey }) => {
          if (keyWasEmpty && effectiveKey) {
            // 把生成的密钥写回设置（幂等带上 enabled），persistApiServer 内部同步编辑态。
            await persistApiServer({ enabled: true, apiKey: effectiveKey });
            return;
          }
          await persistApiServer({ enabled: true });
        },
      });
      if (!result.ok) {
        if (result.reason === 'SETTINGS_UNREADABLE') setApiSettingsLoaded(false);
        return {
          ok: false,
          code: 'START_FAILED',
          message: result.reason === 'SETTINGS_UNREADABLE'
            ? tActive('localModel.alert.apiSettingsUnreadable.body')
            : result.message,
        };
      }
      setApiSettingsLoaded(true);
      setApiStatus({ running: true, port: result.port });
      return { ok: true, generatedKey: result.keyWasEmpty ? result.effectiveKey : '' };
    } catch (error) {
      // 兜底：提交点在启动成功之后，这条路径上盘上不会留下 enabled:true（无需回滚）。
      return { ok: false, code: 'START_FAILED', message: error && error.message };
    } finally {
      setApiBusy(false);
    }
  }, [apiBusy, apiServer.apiKey, apiServer.port, persistApiServer]);

  const stopApi = useCallback(async () => {
    if (apiBusy) return { ok: false, code: 'BUSY' };
    setApiBusy(true);
    try {
      await stopLocalApiServer();
      await persistApiServer({ enabled: false });
      setApiStatus({ running: false, port: 0 });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'STOP_FAILED', message: error && error.message };
    } finally {
      setApiBusy(false);
    }
  }, [apiBusy, persistApiServer]);

  // 展示给用户复制的本地地址：运行中用实际监听端口，未启动时用配置端口，
  // 始终以 /v1 结尾（OpenAI 兼容 base_url）。startLocalApiServer 可能因端口
  // 被占用回落到其他端口，故以 apiStatus.port 为准。
  const apiAddress = useMemo(() => {
    const port = apiStatus.running && apiStatus.port ? apiStatus.port : apiServer.port;
    const effectivePort = Number(port) > 0 ? Number(port) : 8080;
    return `http://127.0.0.1:${effectivePort}/v1`;
  }, [apiStatus.running, apiStatus.port, apiServer.port]);

  const copyApiAddress = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(apiAddress);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'COPY_FAILED' };
    }
  }, [apiAddress]);

  return {
    apiServer,
    setApiServer,
    apiStatus,
    apiBusy,
    // 凭据域是否确认读到（false/ null 时壳可禁用启动入口）；startApi 自身也已 fail-closed。
    apiSettingsLoaded,
    apiAddress,
    hydrate,
    startApi,
    stopApi,
    copyApiAddress,
  };
}
