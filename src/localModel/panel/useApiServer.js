// 服务域：本地 API 服务（OpenAI 兼容）的端口/密钥编辑态、启停与状态轮询。
// 端口在编辑态统一存 string（C6），落盘时 parseInt（非法回退 8080，与存储层
// normalizeLocalModelApiServer 口径一致），读回后再转 string 回填编辑态。
// 反馈约定同其余 hooks：返回 { ok, code, ... }，由壳映射成用户可见文案。

import { useCallback, useMemo, useState } from 'react';

import * as Clipboard from 'expo-clipboard';

import { getLocalModelIndex, getLocalModelSettings } from '../../storage/localModels.js';
import {
  getLocalApiServerStatus,
  isLocalApiServerAvailable,
  startLocalApiServer,
  stopLocalApiServer,
} from '../localApiServer.js';

export function useApiServer({ updateSettings }) {
  const [apiServer, setApiServer] = useState({ enabled: false, host: '127.0.0.1', port: '8080', apiKey: '' });
  const [apiStatus, setApiStatus] = useState({ running: false, port: 0 });
  const [apiBusy, setApiBusy] = useState(false);

  // 打开面板时的全量水合（C7）：只有这里允许用存储值回填编辑态；
  // 操作后的 refresh 绝不碰本域，否则用户正在输入的端口/密钥会被打回。
  const hydrate = useCallback(async () => {
    const [current, status] = await Promise.all([
      getLocalModelSettings().catch(() => null),
      getLocalApiServerStatus().catch(() => ({ running: false, port: 0 })),
    ]);
    if (current && current.apiServer) {
      setApiServer({ ...current.apiServer, port: String(current.apiServer.port || '') });
    }
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
      // 留空即自动生成随机密钥（两端都强制鉴权）；生成后持久化，重启不变。
      const keyWasEmpty = !String(apiServer.apiKey || '').trim();
      const saved = await persistApiServer({ enabled: true });
      // v5 Stage D：把已安装模型列表下发给原生，/v1/models 才能全量返回。
      const installedModels = await getLocalModelIndex().catch(() => []);
      const status = await startLocalApiServer({
        port: Number((saved.apiServer && saved.apiServer.port) || apiServer.port) || 8080,
        apiKey: apiServer.apiKey,
        modelId: saved.activeModelId || 'local-model',
        models: installedModels,
      });
      const effectiveKey = String((status && status.apiKey) || apiServer.apiKey || '');
      if (keyWasEmpty && effectiveKey) {
        // 把生成的密钥写回设置（幂等带上 enabled），persistApiServer 内部同步编辑态。
        await persistApiServer({ enabled: true, apiKey: effectiveKey });
      }
      setApiStatus({ running: true, port: Number(status && status.port) || Number((saved.apiServer && saved.apiServer.port) || apiServer.port) || 8080 });
      return { ok: true, generatedKey: keyWasEmpty ? effectiveKey : '' };
    } catch (error) {
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
    apiAddress,
    hydrate,
    startApi,
    stopApi,
    copyApiAddress,
  };
}
