// 内置 MCP Server 的状态与动作（设置页卡片用）。
//
// 与 useApiServer 的分工一致：卡片只做展示，状态与写入都收在这里。
// 写入统一走 serverRuntime.syncMcpServer —— 它按「当前设置」启停原生服务并回写原生生成的
// token，是唯一事实源；本 hook 不自己调原生，避免出现两条互相矛盾的启停路径。

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';

import { buildMcpConnectionText, buildMcpServerUrl, getMcpServerStatus } from '../mcp/serverBridge.js';
import {
  MCP_SERVER_PORT_DEFAULT,
  MCP_SERVER_PORT_MAX,
  MCP_SERVER_PORT_MIN,
  getMcpServerSettings,
  patchMcpServerSettings,
} from '../storage/settings.js';

export function normalizeMcpPort(raw) {
  const parsed = Math.trunc(Number(String(raw).trim()));
  if (!Number.isFinite(parsed) || parsed < MCP_SERVER_PORT_MIN || parsed > MCP_SERVER_PORT_MAX) {
    return MCP_SERVER_PORT_DEFAULT;
  }
  return parsed;
}

const IDLE_STATUS = { running: false, host: '', port: 0, lanIp: '', available: true };

// 动态 require（不是静态 import）：serverRuntime 拖着工作区/AsyncStorage 重依赖，
// 设置页没必要在启动时就把它拉进静态链（与 serverBridge 的分层理由一致）。
// 失败返回 null：非 Android 或旧构建里根本没有这个原生模块，界面按「本构建不支持」展示。
function getServerRuntime() {
  try {
    return require('../mcp/serverRuntime.js');
  } catch (error) {
    return null;
  }
}

export default function useMcpServer() {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(IDLE_STATUS);
  const [portDraft, setPortDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const [next, st] = await Promise.all([getMcpServerSettings(), getMcpServerStatus()]);
    setSettings(next);
    setPortDraft(String(next.port));
    setTokenDraft(next.mcpToken);
    setStatus(st);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(() => { if (!cancelled) setLoaded(true); })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [refresh]);

  // 唯一的写入口：patch 落盘 → sync 启停（含回写原生生成的 token）→ 刷新展示状态。
  // restart:false 用于「改了不影响监听端口」的字段（三个档位是每次请求现读的，
  // 重启会白白踢掉 agent 的会话，客户端得重新 initialize）。
  const apply = useCallback(async (patch, { restart = true } = {}) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await patchMcpServerSettings(patch);
      setSettings(saved);
      setPortDraft(String(saved.port));
      setTokenDraft(saved.mcpToken);
      if (restart) {
        const runtime = getServerRuntime();
        if (runtime) {
          const applied = await runtime.syncMcpServer();
          setSettings(applied.settings);
          setPortDraft(String(applied.settings.port));
          // 空 token 启动时由原生生成，sync 会回写；这里同步到输入框，用户才能复制。
          setTokenDraft(applied.settings.mcpToken);
          setStatus(applied.status);
          // sync 失败时已把开关回滚成 false，这里把原因如实显示出来（不吞错）。
          setError(applied.error || '');
        } else {
          setStatus(current => ({ ...current, running: false, available: false }));
        }
      }
      return saved;
    } catch (saveError) {
      setError(String((saveError && saveError.message) || saveError || ''));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const setEnabled = useCallback(value => apply({ enabled: value === true }), [apply]);
  const setScope = useCallback(scope => apply({ scope }), [apply]);
  const setTier = useCallback((tier, value) => apply(
    { tiers: { ...(settings ? settings.tiers : {}), [tier]: value === true } },
    { restart: false }
  ), [apply, settings]);
  const commitPort = useCallback(() => {
    const port = normalizeMcpPort(portDraft);
    setPortDraft(String(port));
    if (settings && port === settings.port) return Promise.resolve(null);
    return apply({ port });
  }, [apply, portDraft, settings]);
  // 手改 token：失焦时提交（留空 = 让原生重新生成一个）。
  const commitToken = useCallback(() => {
    const token = String(tokenDraft).trim();
    if (settings && token === settings.mcpToken) return Promise.resolve(null);
    return apply({ mcpToken: token });
  }, [apply, tokenDraft, settings]);
  // 重新生成：清空后交给原生 SecureRandom 生成（sync 会把它回写持久化）。
  // 服务没开时不会立刻生成——UI 的提示说明了「下次启动时生成」。
  const regenerateToken = useCallback(() => apply({ mcpToken: '' }), [apply]);

  const url = buildMcpServerUrl({
    scope: settings ? settings.scope : 'loopback',
    port: settings ? settings.port : MCP_SERVER_PORT_DEFAULT,
    lanIp: status.lanIp,
  });
  const connectionText = buildMcpConnectionText({
    url,
    token: settings ? settings.mcpToken : '',
  });

  const copyConnection = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(connectionText);
      return { ok: true };
    } catch (error) {
      return { ok: false };
    }
  }, [connectionText]);

  return {
    loaded,
    busy,
    error,
    settings,
    status,
    portDraft,
    setPortDraft,
    tokenDraft,
    setTokenDraft,
    url,
    connectionText,
    setEnabled,
    setScope,
    setTier,
    commitPort,
    commitToken,
    regenerateToken,
    copyConnection,
    refresh,
  };
}
