// 图像生成（生图）配置存储：多 provider + 密钥保险箱。从 src/storage/settings.js 原样外提（无行为变化）。

import { isKnownImageProvider } from '../../imageGen/providers.js';
import {
  backupCorruptValue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from '../io.js';
import { normalizeImageProviderId } from './imageProvider.js';
import { tActive } from '../../i18n/index.js';

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

// 生图配置的**三态读 + 形状判定**，读路径与写路径共用这**唯一**一份判据。
//
// 为什么必须共用、且必须判形状：`readJsonStatusWithSecrets` 的 ok 只保证 JSON.parse
// 成功——值可以是 null、原语或数组（合法 JSON 但形状不是预期对象的**第四态**）。
// 旧的 getImageGenSettings 只判 `status === 'corrupt'`，于是 `null` / `[]` / `"x"` / `123`
// 直接进 normalizeImageGenSettings → 返回 `{activeProvider:'', providers:{}}`，
// **而且这一步没有 backupCorruptValue**；用户改一个字段再保存（setJsonWithSecrets 直写）
// 就把整个键覆盖成默认值 ⇒ 全链路没有任何一次备份，旧值不可恢复。
// 本仓既已形成「ok 也要判形状」的惯例（settings/plugins.js、settings/mcpServers.js:188-198
// 的 readMcpServersStatus、collectionStore.js、vector.js），imageGen 不该是唯一漏网的那个。
async function readImageGenStatus() {
  const stored = await readJsonStatusWithSecrets(IMAGE_GEN_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (
      stored.value === null
      || typeof stored.value !== 'object'
      || Array.isArray(stored.value)
    ))
  ) {
    // 覆盖不可逆，先留原始字节的副本，再把「不可用」交给调用方。
    await backupCorruptValue(IMAGE_GEN_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

// 读状态 + 归一化后的值：**写路径拒写**据此判定（与 settings/mcpServers.js 的
// getMcpServersStatus 同型，也与 settings/tts.js:133-138 的 assertReadableForMutation 同理）。
// 只读侧判形状、写侧仍有窗口 —— 本波已多次证明「只防守一侧」不够，所以这里把 status
// 一并导出，读/写两侧走同一个 readImageGenStatus。
export async function getImageGenSettingsStatus() {
  const status = await readImageGenStatus();
  if (status.status === 'corrupt') return { status: 'corrupt' };
  if (status.status === 'missing') return { status: 'missing', value: normalizeImageGenSettings(null) };
  return { status: 'ok', value: normalizeImageGenSettings(status.value) };
}

export async function getImageGenSettings() {
  // 读路径的对外体验保持原样（读不出时给 UI 一份默认值），但原始值**已备份**，
  // 且 saveImageGenSettings 的守卫会拒绝把这个默认值写回去覆盖损坏内容。
  const status = await getImageGenSettingsStatus();
  if (status.status === 'corrupt') return normalizeImageGenSettings(null);
  return status.value;
}

export async function saveImageGenSettings(settings) {
  // 写路径守卫（变体①：读不出原值就不写）。参考 src/storage/settings/chatOptions.js 的
  // assertReadableForMutation 与 src/storage/settings/mcpServers.js:209-229 的 saveMcpServers。
  // 面板侧的 `if (!loaded)` 守卫只挡得住「本次没读成功就保存」，挡不住别处触发的写。
  const status = await readImageGenStatus();
  if (status.status === 'corrupt') {
    throw new Error(tActive('error.storage.imageGenSettingsReadFailed'));
  }
  const normalized = normalizeImageGenSettings(settings);
  await setJsonWithSecrets(IMAGE_GEN_KEY, normalized);
  return normalized;
}
