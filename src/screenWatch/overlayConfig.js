// 悬浮窗大脑的配置快照（M2 大脑搬家）：JS 侧在「看屏幕页打开 / 切换角色」时，
// 把大脑需要的配置一次性喂给原生（writeOverlayConfig）。
//
// 安全（用户拍板，M2 前提 #3）：apiKey 由原生抽到 EncryptedSharedPreferences
//（AES256-GCM，Keystore 托管），落盘文件里**不会有**明文密钥——与本仓库
// proactiveMessage/ProactiveCore.kt 的既有做法一致，**不**按旧文档写明文 json。

import { NativeModules } from 'react-native';
import { getActiveApiConfig, capabilitiesForModel, getActiveModel } from '../storage/apiConfigs.js';
import { getActiveLocale } from '../i18n/index.js';
import { resolveCharacterTranscription } from '../character/runtimeConfig.js';

function nativeModule() {
  return NativeModules.ScreenOverlay || null;
}

function overlayConfigSupported() {
  const module = nativeModule();
  return !!module && typeof module.writeOverlayConfig === 'function';
}

// 角色人设：与 ProactivePanel.js / runUserMomentComments.js 的拼装口径一致
//（同批字段、同一顺序）——三处各写一份必然漂移，这里刻意复用同一批字段。
function rolePersona(character) {
  if (!character) return '';
  const parts = [
    character.systemPrompt,
    character.description,
    character.personality,
    character.scenario,
  ];
  return parts.map(part => String(part || '').trim()).filter(Boolean).join('\n');
}

/**
 * 组配置快照 JSON（设计文档 3.1 的结构）。
 * 拿不到 API 配置时返回 null（大脑没有配置，悬浮窗聊天会回退 JS 管线）。
 */
export async function buildOverlayConfigSnapshot({ character = null } = {}) {
  try {
    const config = await getActiveApiConfig();
    if (!config) return null;
    const model = getActiveModel(config);
    const caps = capabilitiesForModel(config, model);
    // M3 耳朵：ASR 复用既有解析层（resolveCharacterTranscription）——它就是 app 内
    // 语音转文字的单一入口，原生侧照单执行即可，不重复实现「复用聊天来源还是独立配置」
    // 的判定（两处各判一次必然漂移）。拿不到就退回系统识别（provider='system'）。
    let asr = { provider: 'system', baseUrl: '', apiKey: '', model: '' };
    try {
      const resolved = await resolveCharacterTranscription(character ? character.id : '');
      if (resolved && resolved.source !== 'none' && resolved.apiKey) {
        asr = {
          provider: 'cloud',
          baseUrl: String(resolved.baseUrl || ''),
          apiKey: String(resolved.apiKey || ''),
          model: String(resolved.model || ''),
        };
      }
    } catch (error) {
      // ASR 解析失败不影响大脑配置：原生会退回系统识别。
    }
    return JSON.stringify({
      endpoint: {
        baseUrl: String(config.baseUrl || ''),
        apiKey: String(config.apiKey || ''),
        model: String(model || ''),
        protocol: String(config.protocol || 'openai'),
        fallbacks: Array.isArray(config.fallbackModels)
          ? config.fallbackModels.map(item => String(item || '')).filter(Boolean)
          : [],
      },
      capabilities: {
        vision: caps.supportsVision === true,
        audio: caps.supportsAudio === true,
        thinking: caps.supportsThinking === true,
      },
      persona: {
        name: String(character?.name || '').trim(),
        systemPrompt: rolePersona(character),
      },
      asr,
      locale: getActiveLocale(),
    });
  } catch (error) {
    return null;
  }
}

/**
 * 把当前配置快照写入原生大脑。失败静默返回 false——
 * 悬浮窗聊天在无快照时会走 JS 管线回退，不在这里给用户报错。
 */
export async function writeOverlayConfigSnapshot({ character = null } = {}) {
  if (!overlayConfigSupported()) return false;
  const json = await buildOverlayConfigSnapshot({ character });
  if (!json) return false;
  try {
    return !!(await nativeModule().writeOverlayConfig(json));
  } catch (error) {
    return false;
  }
}
