// 备份包的分块序列化：把整包 JSON 切成可增量写盘的片段。
// 纯函数、无 IO，供 src/storage/backup.js 流式写盘与 Node 测试共用。
//
// 动机：整包 JSON.stringify 在超大媒体/数据时会长时间占用主线程且不可取消。
// 这里按「顶层字段 → storage 逐项 → media 逐项」切片、逐片序列化；写盘方
// 逐片写入即可在片间让出主线程、检查取消并上报进度。
//
// 等价性：全部片段按序拼接，与 JSON.stringify(payload) 逐字相同——包括
// undefined 字段被省略、数组中的 undefined 变 null 等细节
// （由 tests/backupStream.test.mjs 以多种形状锁定）。

// 单个片段的字符上限：媒体 base64 可达数十 MB，再切一层保证写盘方
// 每次写入量可控、片与片之间有机会检查取消。
export const BACKUP_CHUNK_CHARS = 256 * 1024;

function* splitLongString(text, size = BACKUP_CHUNK_CHARS) {
  if (text.length <= size) {
    yield text;
    return;
  }
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

// 单个值的序列化片段（数组元素 / 顶层非数组值）。
// JSON.stringify 在数组中对 undefined 产出 null，这里保持一致。
function* yieldSerializedValue(value) {
  const serialized = JSON.stringify(value);
  yield* splitLongString(serialized === undefined ? 'null' : serialized);
}

// 分块序列化生成器：逐片产出字符串，拼接后与 JSON.stringify(payload) 等价。
// 顶层为对象；字段按插入顺序输出，与 JSON.stringify 的键序语义一致。
export function* createBackupChunkGenerator(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('备份内容无效');
  }
  yield '{';
  let first = true;
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    // JSON.stringify 会省略值为 undefined / 函数 / symbol 的属性。
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    if (!first) yield ',';
    first = false;
    yield `${JSON.stringify(key)}:`;
    if (Array.isArray(value)) {
      // 顶层数组（storage/media）逐元素序列化：大媒体条目的 base64 由此被
      // 切分，元素之间成为天然的可取消检查点。
      yield '[';
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ',';
        yield* yieldSerializedValue(value[index]);
      }
      yield ']';
    } else {
      yield* yieldSerializedValue(value);
    }
  }
  yield '}';
}

// 一次性收集全部分片（测试与需要完整字符串的调用方使用）。
export function createBackupChunks(payload) {
  return Array.from(createBackupChunkGenerator(payload));
}

// 分片流的 UTF-8 字节数（与 utf8ByteLength(JSON.stringify(payload)) 等价）。
export function utf8ByteLengthOfChunks(chunks) {
  let bytes = 0;
  for (const chunk of chunks) {
    const value = String(chunk || '');
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
  }
  return bytes;
}
