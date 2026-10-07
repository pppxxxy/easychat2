// 插件配置存储：内置插件清单、供应商迁移标记、密钥保险箱。从 src/storage/settings.js 原样外提（无行为变化）。

import {
  backupCorruptValue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from '../io.js';
import { tActive } from '../../i18n/index.js';

const PLUGINS_KEY = '@easychat2_plugins';

const DEFAULT_PLUGINS = [
  {
    id: 'web-search',
    name: '联网搜索',
    nameKey: 'plugin.webSearch.name',
    description: '角色可搜索网络信息，结合时事回答。',
    descriptionKey: 'plugin.webSearch.desc',
    type: 'web-search',
    enabled: false,
    config: {
      provider: 'serpapi',
      apiKey: '',
      cx: '',
      customBaseUrl: '',
      maxResults: 5,
    },
  },
];

// Bing Search API 已于 2025-08-11 停服（微软 2025-05 公告），不再列入供应商：
// 存量 bing 配置会被规范化回该插件的默认 provider。
const PLUGIN_PROVIDERS = ['serpapi', 'google-cse', 'brave', 'tavily', 'custom'];

function normalizePlugin(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preset = DEFAULT_PLUGINS.find(item => item.id === source.id);
  const defaultConfig = (preset && preset.config) || {};
  const config = source.config && typeof source.config === 'object' && !Array.isArray(source.config)
    ? source.config
    : {};
  const rawProvider = String(config.provider || '').trim();
  const provider = PLUGIN_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : (defaultConfig.provider || 'serpapi');
  // 存量供应商已停服/移除（如 Bing，2025-08 停服）被换源时留下迁移标记，
  // 由设置面板读取后给出一次性可见提示——不做无痕静默换源。
  const providerMigrated = rawProvider && !PLUGIN_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : '';
  const maxResults = Math.trunc(Number(config.maxResults));
  return {
    id: String(source.id || `plugin-${index}`),
    name: String(source.name || (preset && preset.name) || tActive('plugin.webSearch.numberedName', { index: index + 1 })),
    nameKey: preset && preset.nameKey ? preset.nameKey : '',
    description: String(source.description || (preset && preset.description) || ''),
    descriptionKey: preset && preset.descriptionKey ? preset.descriptionKey : '',
    type: String(source.type || (preset && preset.type) || ''),
    enabled: source.enabled === true,
    config: {
      provider,
      apiKey: String(config.apiKey || ''),
      cx: String(config.cx || ''),
      customBaseUrl: String(config.customBaseUrl || ''),
      maxResults: Number.isFinite(maxResults) && maxResults > 0
        ? Math.min(maxResults, 10)
        : 5,
      ...(providerMigrated ? { providerMigrated } : {}),
    },
  };
}

function buildDefaultPlugins() {
  return DEFAULT_PLUGINS.map(preset => normalizePlugin(preset));
}

export async function getPlugins() {
  const stored = await readJsonStatusWithSecrets(PLUGINS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 插件配置此前读失败会直接用默认值整表覆盖。先备份原值再返回默认，且本次不落盘，
    // 避免把用户填过的密钥 / 开关不可逆地冲掉。
    await backupCorruptValue(PLUGINS_KEY);
    return buildDefaultPlugins();
  }
  const list = stored.status === 'ok' ? stored.value.map(normalizePlugin) : [];
  let changed = stored.status === 'missing';
  DEFAULT_PLUGINS.forEach(preset => {
    if (!list.some(item => item.id === preset.id)) {
      list.push(normalizePlugin(preset));
      changed = true;
    }
  });
  if (changed) {
    try {
      await setJsonWithSecrets(PLUGINS_KEY, list);
    } catch (error) {}
  }
  return list;
}

export async function savePlugins(plugins) {
  const list = (Array.isArray(plugins) ? plugins : []).map(normalizePlugin);
  DEFAULT_PLUGINS.forEach(preset => {
    if (!list.some(item => item.id === preset.id)) {
      list.push(normalizePlugin(preset));
    }
  });
  await setJsonWithSecrets(PLUGINS_KEY, list);
  return list;
}

export async function getEnabledPlugins() {
  const list = await getPlugins();
  return list.filter(plugin => plugin.enabled === true);
}
