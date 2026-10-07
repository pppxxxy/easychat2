// GitHub MCP 连接的设置页编排（2026-10-07 快赢2 自 SettingsScreen 编排层迁出）。
// 网页认证：发现授权服务器 → 动态注册 → 系统浏览器授权（PKCE）→ 回调换令牌。
// 任何一步失败都提示改用 PAT；令牌方式是稳定兜底。
// data 层错误带稳定 code：这里按 code 映射成用户文案（纯模块不做 i18n）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  clearGithubMcpCredentials,
  connectGithubMcpWithToken,
  getGithubMcpSettings,
} from '../storage/githubMcp.js';

// GitHub 令牌创建页（方式二「打开令牌页」的落地页）。
// 为什么不做网页授权：GitHub 的远程 MCP 不提供动态客户端注册（RFC 7591 的 /register
// 端点不存在）——流程会在「注册应用」一步失败，浏览器根本不会打开，用户看到的就是
// 「点了按钮没跳转」。令牌页一定可用，且能顺带把权限勾选问清楚。
const GITHUB_TOKEN_PAGE_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=EasyChat2';

const GITHUB_ERROR_KEYS = {
  GITHUB_TOKEN_EMPTY: 'settings.github.err.empty',
  GITHUB_ENDPOINT_HTTPS: 'settings.github.err.endpoint',
  GITHUB_NOT_CONNECTED: 'settings.github.err.notConnected',
  MCP_AUTH_FAILED: 'settings.github.err.auth',
  MCP_HTTP_ERROR: 'settings.github.err.mcpHttp',
  MCP_INVALID_RESPONSE: 'settings.github.err.mcpResponse',
  OAUTH_METADATA_NOT_FOUND: 'settings.github.err.metadata',
  OAUTH_NO_REGISTRATION: 'settings.github.err.registration',
  MCP_TIMEOUT: 'settings.github.err.mcpTimeout',
  OAUTH_STATE_MISMATCH: 'settings.github.err.state',
  OAUTH_TIMEOUT: 'settings.github.err.timeout',
  OAUTH_ACCESS_DENIED: 'settings.github.err.denied',
  OAUTH_TOKEN_EXCHANGE: 'settings.github.err.exchange',
  OAUTH_BROWSER_UNAVAILABLE: 'settings.github.err.browser',
};

const githubAlertText = (error, translate) => {
  const key = error && error.code && GITHUB_ERROR_KEYS[error.code];
  return key ? translate(key) : ((error && error.message) || translate('settings.github.err.body'));
};

export default function useGithubMcp() {
  const { t } = useTranslation();
  // 两个按钮的进行中状态必须分开：此前共用 githubBusy，点「打开令牌页」时亮的是
  // 上面「连接」按钮的「连接中…」，用户以为状态串了、也看不出自己点的那步在干嘛。
  const [githubMcp, setGithubMcp] = useState(null);
  const [githubPat, setGithubPat] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubPageBusy, setGithubPageBusy] = useState(false);
  const githubMcpSummaryRef = useRef({ allowedCount: 0, confirmCount: 0, deniedCount: 0 });

  const loadGithubMcp = useCallback(async () => {
    try { setGithubMcp(await getGithubMcpSettings()); } catch (error) { setGithubMcp(null); }
  }, []);

  useEffect(() => { loadGithubMcp(); }, [loadGithubMcp]);

  const afterGithubConnect = useCallback(async () => {
    await loadGithubMcp();
    Alert.alert(
      t('settings.github.done.title'),
      t('settings.github.done.body', {
        count: githubMcpSummaryRef.current.allowedCount,
        confirm: githubMcpSummaryRef.current.confirmCount,
        denied: githubMcpSummaryRef.current.deniedCount,
      })
    );
  }, [loadGithubMcp, t]);

  const connectGithubPat = useCallback(async () => {
    if (githubBusy) return;
    const token = githubPat.trim();
    if (!token) {
      Alert.alert(t('settings.github.err.title'), t('settings.github.err.empty'));
      return;
    }
    setGithubBusy(true);
    try {
      const summary = await connectGithubMcpWithToken({ token, authMethod: 'pat' });
      githubMcpSummaryRef.current = summary;
      setGithubPat('');
      await afterGithubConnect();
    } catch (error) {
      Alert.alert(t('settings.github.err.title'), githubAlertText(error, t));
    } finally {
      setGithubBusy(false);
    }
  }, [afterGithubConnect, githubBusy, githubPat, t]);

  // 方式二：打开 GitHub 令牌创建页（不是 OAuth 网页授权）。
  // GitHub 的远程 MCP 不支持动态客户端注册，网页授权必然在「注册应用」一步失败、
  // 浏览器根本打不开——用户的实际观感就是「点了按钮没跳转」。令牌页则一定可用：
  // 在那里生成 PAT（权限已预勾选），复制回来粘贴到上面的输入框即可。
  const openGithubTokenPage = useCallback(async () => {
    if (githubPageBusy) return;
    setGithubPageBusy(true);
    try {
      await Linking.openURL(GITHUB_TOKEN_PAGE_URL);
    } catch (error) {
      Alert.alert(t('settings.github.err.title'), t('settings.github.err.openPage'));
    } finally {
      setGithubPageBusy(false);
    }
  }, [githubPageBusy, t]);

  const disconnectGithub = useCallback(() => {
    Alert.alert(t('settings.github.disconnect.title'), t('settings.github.disconnect.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.github.disconnect.ok'),
        style: 'destructive',
        onPress: () => { clearGithubMcpCredentials().then(loadGithubMcp).catch(() => {}); },
      },
    ]);
  }, [loadGithubMcp, t]);

  return {
    githubMcp,
    githubPat,
    setGithubPat,
    githubBusy,
    githubPageBusy,
    connectGithubPat,
    openGithubTokenPage,
    disconnectGithub,
  };
}
