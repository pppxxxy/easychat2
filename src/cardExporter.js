import * as FileSystem from 'expo-file-system';
import { Buffer } from 'buffer';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function uint32BE(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readUint32(data, offset) {
  return (
    ((data[offset] << 24)
      | (data[offset + 1] << 16)
      | (data[offset + 2] << 8)
      | data[offset + 3]) >>> 0
  );
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.length === 'number') return Uint8Array.from(input);
  return new Uint8Array(0);
}

function isPng(bytes) {
  if (bytes.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function makeChunk(type, data) {
  const typeBytes = Uint8Array.from(Array.from(type).map(ch => ch.charCodeAt(0)));
  const body = concatBytes([typeBytes, data]);
  return concatBytes([uint32BE(data.length), body, uint32BE(crc32(body))]);
}

function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function makeTextChunk(keyword, value) {
  return makeChunk(
    'tEXt',
    concatBytes([
      encodeLatin1(keyword),
      Uint8Array.from([0]),
      encodeLatin1(value),
    ])
  );
}

function deflateStored(bytes) {
  const parts = [Uint8Array.from([0x78, 0x01])];
  const maxBlock = 65535;
  let offset = 0;
  do {
    const size = Math.min(bytes.length - offset, maxBlock);
    const final = offset + size >= bytes.length ? 1 : 0;
    parts.push(Uint8Array.from([
      final,
      size & 0xff,
      (size >>> 8) & 0xff,
      (~size) & 0xff,
      ((~size) >>> 8) & 0xff,
    ]));
    parts.push(bytes.slice(offset, offset + size));
    offset += size;
  } while (offset < bytes.length);
  parts.push(uint32BE(adler32(bytes)));
  return concatBytes(parts);
}

export function createPlaceholderPng(width = 2, height = 2) {
  const rowSize = 1 + width * 3;
  const raw = new Uint8Array(height * rowSize);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = 0x6c;
      raw[pixel + 1] = 0x63;
      raw[pixel + 2] = 0xff;
    }
  }
  const ihdr = concatBytes([
    uint32BE(width),
    uint32BE(height),
    Uint8Array.from([8, 2, 0, 0, 0]),
  ]);
  return concatBytes([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateStored(raw)),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

export function injectCharaChunk(pngBytes, jsonText) {
  const bytes = toUint8Array(pngBytes);
  if (!isPng(bytes)) {
    throw new Error('头像不是合法的 PNG 文件');
  }
  const base64 = Buffer.from(String(jsonText), 'utf8').toString('base64');
  const textChunk = makeTextChunk('chara', base64);
  const parts = [PNG_SIGNATURE];
  let offset = 8;
  let inserted = false;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const total = 12 + length;
    if (type === 'IDAT' && !inserted) {
      parts.push(textChunk);
      inserted = true;
    }
    parts.push(bytes.slice(offset, offset + total));
    offset += total;
    if (type === 'IEND') break;
  }
  if (!inserted) {
    parts.push(textChunk);
  }
  return concatBytes(parts);
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
    selective: source.selective !== false,
    enabled: source.enabled !== false,
    position: Number.isFinite(Number(source.position)) ? Number(source.position) : 0,
    insertion_order: Number.isFinite(Number(source.order)) ? Number(source.order) : 100,
    case_sensitive: source.caseSensitive === true,
    use_regex: source.useRegex !== false,
    extensions: {
      position: Number.isFinite(Number(source.position)) ? Number(source.position) : 0,
      depth: Number.isFinite(Number(source.depth)) ? Number(source.depth) : 4,
      probability: Number.isFinite(Number(source.probability)) ? Number(source.probability) : 100,
      useProbability: source.useProbability !== false,
      scan_depth: Number.isFinite(Number(source.scanDepth)) ? Number(source.scanDepth) : null,
    },
  };
}

function mapRegexScript(script) {
  const source = script || {};
  return {
    id: source.id,
    scriptName: String(source.name || ''),
    findRegex: String(source.findRegex || ''),
    replaceString: String(source.replaceString || ''),
    flags: String(source.flags || 'g'),
    placement: Array.isArray(source.placement) ? source.placement.map(Number) : [1, 2],
    disabled: source.enabled === false,
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
    minDepth: source.minDepth === null || source.minDepth === undefined ? null : Number(source.minDepth),
    maxDepth: source.maxDepth === null || source.maxDepth === undefined ? null : Number(source.maxDepth),
  };
}

export function buildCardV2(character) {
  const source = character || {};
  const data = {
    name: String(source.name || ''),
    description: String(source.description || ''),
    personality: String(source.personality || ''),
    scenario: String(source.scenario || ''),
    first_mes: String(source.firstMes || ''),
    alternate_greetings: Array.isArray(source.alternateGreetings)
      ? source.alternateGreetings.map(item => String(item || ''))
      : [],
    mes_example: String(source.mesExample || ''),
    creator_notes: String(source.creatorNotes || ''),
    system_prompt: String(source.systemPrompt || source.systemPromptComposed || ''),
    post_history_instructions: String(source.postHistoryInstructions || ''),
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    character_book: {
      entries: (Array.isArray(source.worldInfo) ? source.worldInfo : []).map(mapWorldEntry),
    },
    extensions: {
      regex_scripts: (Array.isArray(source.regexScripts) ? source.regexScripts : [])
        .map(mapRegexScript),
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
    } catch (error) {}
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
    const uri = `${dir}${name}.png`;
    await FileSystem.writeAsStringAsync(uri, Buffer.from(bytes).toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return uri;
  }
  const uri = `${dir}${name}.json`;
  await FileSystem.writeAsStringAsync(uri, cardToJson(character));
  return uri;
}
