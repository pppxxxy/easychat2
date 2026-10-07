import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { appendExportNotice, isValidAigcMeta } from '../aigc/attribution.js';
import { MEMORY_SUMMARY_PREFIX } from '../memory/memoryConstants.js';
import { tActive } from '../i18n/index.js';
import {
  createPlaceholderPng,
  encodeBitmapPng,
  injectCharaChunk as injectCharaChunkShared,
  isPng,
  toUint8Array,
} from '../share/png.js';
import { encodeQr, EC_LEVEL_L } from '../share/qr.js';

export const MAX_CARD_FILE_BYTES = 32 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function assertCardFileSize(bytes, format) {
  const length = Number(bytes);
  if (Number.isFinite(length) && length > MAX_CARD_FILE_BYTES) {
    throw new Error(
      `角色卡导出后为 ${formatFileSize(length)}，超过应用 ${formatFileSize(MAX_CARD_FILE_BYTES)} 的导入上限，请精简内容${format === 'png' ? '或改用 JSON 导出' : ''}。`
    );
  }
}

// PNG 原语（CRC/分块/tEXt/deflate/占位图/嵌入 chara 块）已迁至 src/share/png.js，
// 与分享二维码共用同一套实现。这里保留同名导出，外部调用点不变。
// base64 编码经依赖注入（Buffer 由本模块提供），让 share/png.js 保持零依赖、Node 可直测。

export { createPlaceholderPng, isPng };

export function injectCharaChunk(pngBytes, jsonText) {
  try {
    return injectCharaChunkShared(
      pngBytes,
      jsonText,
      text => Buffer.from(String(text), 'utf8').toString('base64')
    );
  } catch (error) {
    throw new Error(tActive('error.cardExport.invalidPng'));
  }
}

function mapWorldEntry(entry) {
  const source = entry || {};
  return {
    id: source.id,
    comment: String(source.comment || ''),
    keys: Array.isArray(source.keys) ? source.keys.map(String) : [],
    secondary_keys: Array.isArray(source.secondaryKeys) ? source.secondaryKeys.map(String) : [],
    content: String(source.content || ''),
    constant: source.constant === true,
    selective: source.selective === true,
    enabled: source.enabled !== false,
    position: Number.isFinite(Number(source.position)) ? Number(source.position) : 0,
    role: source.role === 'user' || source.role === 'assistant' ? source.role : 'system',
    insertion_order: Number.isFinite(Number(source.order)) ? Number(source.order) : 100,
    case_sensitive: source.caseSensitive === true,
    match_whole_words: source.matchWholeWords === true,
    use_regex: source.useRegex === true,
    use_probability: source.useProbability !== false,
    extensions: {
      position: Number.isFinite(Number(source.position)) ? Number(source.position) : 0,
      role: source.role === 'user' ? 1 : source.role === 'assistant' ? 2 : 0,
      depth: Number.isFinite(Number(source.depth)) ? Number(source.depth) : 4,
      probability: Number.isFinite(Number(source.probability)) ? Number(source.probability) : 100,
      useProbability: source.useProbability !== false,
      match_whole_words: source.matchWholeWords === true,
      case_sensitive: source.caseSensitive === true,
      // 显式判断 null/undefined：Number(null)===0 会让「未设置」被导出成 0，
      // 重新导入后从默认扫描深度 4 退化为 1（lorebook 的 Math.max(1,0)）。
      scan_depth: source.scanDepth === null || source.scanDepth === undefined
        ? null
        : (Number.isFinite(Number(source.scanDepth)) ? Number(source.scanDepth) : null),
       boundary: source.boundary ? String(source.boundary) : '',
     },
     boundary: source.boundary ? String(source.boundary) : '',
   };
}

function mapRegexScript(script) {
  const source = script || {};
  return {
    id: source.id,
    scriptName: String(source.name || ''),
    findRegex: String(source.findRegex || ''),
    replaceString: String(source.replaceString || ''),
    // flags 为空串是有意义的值（只替换首个匹配）。用 nullish 判断而不是 ||，
    // 否则空串会被改写成 'g'，导入→导出往返后替换语义从「首个」变成「全部」。
    flags: source.flags === null || source.flags === undefined ? 'g' : String(source.flags),
    placement: Array.isArray(source.placement) ? source.placement.map(Number) : [1, 2],
    disabled: source.enabled === false,
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
    minDepth: source.minDepth === null || source.minDepth === undefined ? null : Number(source.minDepth),
    maxDepth: source.maxDepth === null || source.maxDepth === undefined ? null : Number(source.maxDepth),
  };
}

function mapCharacterPreset(preset) {
  const source = preset || {};
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    description: String(source.description || ''),
    prompt: String(source.prompt || ''),
    enabled: source.enabled !== false,
  };
}

export function buildCardV2(character) {
  const source = character || {};
  const presets = (Array.isArray(source.presets) ? source.presets : []).map(mapCharacterPreset);
  const passthroughExtra = isPlainObject(source.cardExtra) ? source.cardExtra : {};
  const passthroughExtensions = isPlainObject(source.cardExtensions) ? source.cardExtensions : {};
  // AI 生成的卡（aigcMeta 存在）导出时：隐式标识进元数据（可识别追溯），
  // 显式标识追加在 creator_notes 尾部（卡查看器界面可见）。
  const aigcMeta = isValidAigcMeta(source.aigcMeta) ? source.aigcMeta : null;
  const data = {
    ...passthroughExtra,
    name: String(source.name || ''),
    description: String(source.description || ''),
    personality: String(source.personality || ''),
    scenario: String(source.scenario || ''),
    first_mes: String(source.firstMes || ''),
    alternate_greetings: Array.isArray(source.alternateGreetings)
      ? source.alternateGreetings.map(item => String(item || ''))
      : [],
    mes_example: String(source.mesExample || ''),
    creator_notes: aigcMeta
      ? appendExportNotice(String(source.creatorNotes || ''))
      : String(source.creatorNotes || ''),
     system_prompt: String(source.systemPrompt ?? source.systemPromptComposed ?? ''),
    post_history_instructions: String(source.postHistoryInstructions || ''),
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    character_book: {
      // 导出**不带**「记忆总结」条目：那是本机某个会话的记忆，不是角色设定。
      // 带出去再导入到别的卡（换机 / 分享 / 克隆）就是跨卡串记忆——那张卡会把
      // 别人的对话记忆当成自己的角色记忆直接注入（见审查待办「记忆归属对账」）。
      entries: (Array.isArray(source.worldInfo) ? source.worldInfo : [])
        .filter(entry => !String((entry && entry.comment) || '').trim().startsWith(MEMORY_SUMMARY_PREFIX))
        .map(mapWorldEntry),
    },
    extensions: {
      ...passthroughExtensions,
      regex_scripts: (Array.isArray(source.regexScripts) ? source.regexScripts : [])
        .map(mapRegexScript),
      easychat2: {
        version: 1,
        character_presets: presets,
        ...(aigcMeta ? { aigc_meta: aigcMeta } : null),
      },
    },
  };
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
  card.name = data.name;
  card.description = data.description;
  card.personality = data.personality;
  card.scenario = data.scenario;
  card.first_mes = data.first_mes;
  card.alternate_greetings = data.alternate_greetings;
  card.mes_example = data.mes_example;
  card.creator_notes = data.creator_notes;
  card.system_prompt = data.system_prompt;
  card.post_history_instructions = data.post_history_instructions;
  card.tags = data.tags;
  card.character_book = data.character_book;
  card.extensions = data.extensions;
  card.character_presets = presets;
  return card;
}

export function cardToJson(character) {
  return JSON.stringify(buildCardV2(character), null, 2);
}

export function cardToPng(character, avatarBytes) {
  const jsonText = cardToJson(character);
  const avatar = avatarBytes ? toUint8Array(avatarBytes) : null;
  if (avatar && avatar.length > 0) {
    try {
      return injectCharaChunk(avatar, jsonText);
    } catch (error) {
      throw new Error(tActive('error.cardExport.invalidPngExport'));
    }
  }
  return injectCharaChunk(createPlaceholderPng(), jsonText);
}

function safeFileName(character) {
  const base = String((character && character.name) || 'character')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'character';
}

export async function exportCardFile(character, format, avatarBytes) {
  const dir = `${FileSystem.cacheDirectory}card-export/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const name = safeFileName(character);
  if (format === 'png') {
    const bytes = cardToPng(character, avatarBytes);
    assertCardFileSize(bytes.length, 'png');
    const uri = `${dir}${name}.png`;
    await FileSystem.writeAsStringAsync(uri, Buffer.from(bytes).toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return uri;
  }
  const json = cardToJson(character);
  assertCardFileSize(Buffer.byteLength(json, 'utf8'), 'json');
  const uri = `${dir}${name}.json`;
  await FileSystem.writeAsStringAsync(uri, json);
  return uri;
}

// ---- 分享用的落盘入口 ----
// 放在本模块（角色卡域的文件封装点）而不是 UI 里：UI 层被禁止直接 import
// expo-file-system（见 eslint.config.mjs 的分层规则），且写入逻辑与导出同源，
// 分散到两处必然漂移。

// 分享二维码：把分享码编成二维码 PNG 并落盘到缓存，返回可给 <Image> 用的 uri。
export async function exportShareQrFile(code, options = {}) {
  const { modules } = encodeQr(String(code || ''), { level: EC_LEVEL_L });
  const bytes = encodeBitmapPng(modules, {
    scale: Number.isFinite(options.scale) ? options.scale : 6,
    quiet: Number.isFinite(options.quiet) ? options.quiet : 4,
    dark: 0x00,
    light: 0xff,
  });
  const dir = `${FileSystem.cacheDirectory}card-share/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`;
  await FileSystem.writeAsStringAsync(uri, Buffer.from(bytes).toString('base64'), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

// 分享为图片：带角色数据的 PNG（对方存图后可用导入功能读回），返回 uri。
export async function exportSharePngFile(character, avatarBytes) {
  const bytes = cardToPng(character, avatarBytes);
  assertCardFileSize(bytes.length, 'png');
  const dir = `${FileSystem.cacheDirectory}card-share/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}${safeFileName(character)}-share.png`;
  await FileSystem.writeAsStringAsync(uri, Buffer.from(bytes).toString('base64'), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}
