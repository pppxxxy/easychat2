// 图像生成（生图）配置存储：多 provider + 密钥保险箱。从 src/storage/settings.js 原样外提（无行为变化）。

import { isKnownImageProvider } from '../../imageGen/providers.js';
import {
  backupCorruptValue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from '../io.js';
import { normalizeImageProviderId } from './imageProvider.js';

const IMAGE_GEN_KEY = '@easychat2_image_gen';

function normalizeImageGenProvider(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let extra = {};
  if (typeof source.extra === 'string') {
    try {
      const parsed = JSON.parse(source.extra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
    } catch (error) {
      extra = {};
    }
  } else if (source.extra && typeof source.extra === 'object' && !Array.isArray(source.extra)) {
    extra = source.extra;
  }
  return {
    apiKey: String(source.apiKey || ''),
    baseUrl: String(source.baseUrl || ''),
    model: String(source.model || ''),
    extra,
  };
}

function normalizeImageGenSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const providers = {};
  const list = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
    ? source.providers
    : {};
  Object.entries(list).forEach(([id, value]) => {
    if (isKnownImageProvider(String(id))) providers[String(id)] = normalizeImageGenProvider(value);
  });
  return {
    activeProvider: normalizeImageProviderId(source.activeProvider),
    providers,
  };
}

export async function getImageGenSettings() {
  // 与 TTS/转写/插件一致：损坏时先另存原始值再回落默认，避免下次保存把损坏内容
  // 不可逆覆盖（图像生成配置里的 providers 会丢）。
  const stored = await readJsonStatusWithSecrets(IMAGE_GEN_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(IMAGE_GEN_KEY);
    return normalizeImageGenSettings(null);
  }
  return normalizeImageGenSettings(stored.value);
}

export async function saveImageGenSettings(settings) {
  const normalized = normalizeImageGenSettings(settings);
  await setJsonWithSecrets(IMAGE_GEN_KEY, normalized);
  return normalized;
}
