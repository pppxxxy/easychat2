// MCP 服务器（第三方）管理的设置页编排（spec: agent-extensibility T1-d）。
// 数据层在 storage/settings/mcpServers.js；这里只管表单态、连接测试与持久化。
// data 层错误带稳定 code：按 code 映射成用户文案（纯逻辑不做 i18n）。
// 内置 GitHub 仍走专用卡（settings/sections/GithubSection.js），本 hook 不管它。

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../i18n/I18nContext.js';
import { createMcpSession } from '../mcp/client.js';
import {
  applyConnectResult,
  getMcpServers,
  makeMcpServerId,
  parseHeadersText,
  removeMcpServer,
  saveMcpServers,
  upsertMcpServer,
} from '../storage/settings/mcpServers.js';

const MCP_ERROR_KEYS = {
  MCP_AUTH_FAILED: 'settings.mcp.err.auth',
  MCP_HTTP_ERROR: 'settings.mcp.err.http',
  MCP_INVALID_RESPONSE: 'settings.mcp.err.response',
  MCP_TIMEOUT: 'settings.mcp.err.timeout',
  MCP_NO_FETCH: 'settings.mcp.err.fetch',
};

const mcpAlertText = (error, translate) => {
  const key = error && error.code && MCP_ERROR_KEYS[error.code];
  return key ? translate(key) : ((error && error.message) || translate('settings.mcp.err.body'));
};

export default function useMcpServers({ onChanged } = {}) {
  const { t } = useTranslation();
  const [servers, setServers] = useState([]);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');

  const load = useCallback(async () => {
    try {
      setServers(await getMcpServers());
    } catch (error) {
      setServers([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const notifyChanged = useCallback(() => {
    if (typeof onChanged === 'function') onChanged();
  }, [onChanged]);

  // 连接测试（添加与重测共用）：起会话 → 拉目录 → 按该服务器分域过滤 → 落盘。
  // 只在成功时覆盖目录——连接失败不破坏已有的可用目录。
  const connectAndSave = useCallback(async draft => {
    const session = createMcpSession({
      endpoint: draft.endpoint,
      token: draft.mcpToken,
      headers: draft.headers,
    });
    try {
      const tools = await session.listTools();
      // MCP 完整性：连接时一并拉 resources / prompts（不支持时静默空，不影响连接成功）。
      const resources = await session.listResources().catch(() => []);
      const prompts = await session.listPrompts().catch(() => []);
      const updated = applyConnectResult(draft, tools, { resources, prompts });
      if (!updated) throw new Error('invalid server record');
      const next = upsertMcpServer(await getMcpServers(), updated);
      await saveMcpServers(next);
      return updated;
    } finally {
      if (session && typeof session.close === 'function') session.close();
    }
  }, []);

  const doneText = updated => t('settings.mcp.done.body', {
    name: updated.name,
    count: updated.toolCatalog.length,
    denied: updated.deniedNames.length,
  });

  const addServer = useCallback(async () => {
    if (busy) return;
    const label = name.trim();
    const url = endpoint.trim();
    if (!label) {
      Alert.alert(t('settings.mcp.err.title'), t('settings.mcp.err.name'));
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      Alert.alert(t('settings.mcp.err.title'), t('settings.mcp.err.endpoint'));
      return;
    }
    const draft = {
      id: makeMcpServerId(label),
      name: label,
      endpoint: url,
      authMethod: 'token',
      mcpToken: token.trim(),
      headers: parseHeadersText(headersText),
      enabled: false,
    };
    setBusy(true);
    try {
      const updated = await connectAndSave(draft);
      await load();
      setName('');
      setEndpoint('');
      setToken('');
      setHeadersText('');
      notifyChanged();
      Alert.alert(t('settings.mcp.done.title'), doneText(updated));
    } catch (error) {
      Alert.alert(t('settings.mcp.err.title'), mcpAlertText(error, t));
    } finally {
      setBusy(false);
    }
  }, [busy, name, endpoint, token, headersText, connectAndSave, load, notifyChanged, t]);

  const testServer = useCallback(async server => {
    if (testingId) return;
    setTestingId(server.id);
    try {
      const updated = await connectAndSave(server);
      await load();
      notifyChanged();
      Alert.alert(t('settings.mcp.done.title'), doneText(updated));
    } catch (error) {
      Alert.alert(t('settings.mcp.err.title'), mcpAlertText(error, t));
    } finally {
      setTestingId('');
    }
  }, [testingId, connectAndSave, load, notifyChanged, t]);

  const toggleServer = useCallback(async (server, enabled) => {
    try {
      const next = upsertMcpServer(await getMcpServers(), { ...server, enabled: enabled === true });
      await saveMcpServers(next);
      await load();
      notifyChanged();
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, [load, notifyChanged, t]);

  const removeServer = useCallback(server => {
    Alert.alert(
      t('settings.mcp.remove.title'),
      t('settings.mcp.remove.body', { name: server.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.mcp.remove.ok'),
          style: 'destructive',
          onPress: () => {
            getMcpServers()
              .then(list => saveMcpServers(removeMcpServer(list, server.id)[0]))
              .then(() => { load(); notifyChanged(); })
              .catch(() => {});
          },
        },
      ]
    );
  }, [load, notifyChanged, t]);

  return {
    servers,
    name,
    setName,
    endpoint,
    setEndpoint,
    token,
    setToken,
    headersText,
    setHeadersText,
    busy,
    testingId,
    addServer,
    testServer,
    toggleServer,
    removeServer,
  };
}
