// 二维码编码器（ISO/IEC 18004，字节模式，纠错档 L/M）。
//
// 为什么自己写而不装库：这个项目跑在 Hermes 上、又要能在 Node 里直测，
// 依赖一个带原生或 ESM-only 的二维码库会同时给包体和测试加载器添麻烦。
// 本项目只需要「把一段 ASCII 文本变成 0/1 矩阵」这一件事，实现约 200 行，
// 且能用测试与独立实现（qrcode-terminal 自带的 QRCode）逐格比对，
// 比引依赖更可控。
//
// 纯逻辑，零依赖，Node 可直测。矩阵输出为 boolean[row][col]（true = 深色）。

// 纠错档：数值与 spec 一致（编码进格式信息时用 0b01/0b00）。
export const EC_LEVEL_L = 1;
export const EC_LEVEL_M = 0;

// 版本 1..40 的 RS 分块表（ISO/IEC 18004 表 13-22），每项为
// [块数, 每块总码字数, 每块数据码字数, (可重复)] —— 一个版本可能混用两种分块。
const RS_BLOCK_TABLE = {
  L: [
    [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
    [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116], [2, 86, 68, 2, 87, 69],
    [4, 101, 81], [2, 116, 92, 2, 117, 93], [4, 133, 107], [3, 145, 115, 1, 146, 116],
    [5, 109, 87, 1, 110, 88], [5, 122, 98, 1, 123, 99], [1, 135, 107, 5, 136, 108],
    [5, 150, 120, 1, 151, 121], [3, 141, 113, 4, 142, 114], [3, 135, 107, 5, 136, 108],
    [4, 144, 116, 4, 145, 117], [2, 139, 111, 7, 140, 112], [4, 151, 121, 5, 152, 122],
    [6, 147, 117, 4, 148, 118], [8, 132, 106, 4, 133, 107], [10, 142, 114, 2, 143, 115],
    [8, 152, 122, 4, 153, 123], [3, 147, 117, 10, 148, 118], [7, 146, 116, 7, 147, 117],
    [5, 145, 115, 10, 146, 116], [13, 145, 115, 3, 146, 116], [17, 145, 115],
    [17, 145, 115, 1, 146, 116], [13, 145, 115, 6, 146, 116], [12, 151, 121, 7, 152, 122],
    [6, 151, 121, 14, 152, 122], [17, 152, 122, 4, 153, 123], [4, 152, 122, 18, 153, 123],
    [20, 147, 117, 4, 148, 118], [19, 148, 118, 6, 149, 119],
  ],
  M: [
    [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
    [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37],
    [4, 69, 43, 1, 70, 44], [1, 80, 50, 4, 81, 51], [6, 58, 36, 2, 59, 37],
    [8, 59, 37, 1, 60, 38], [4, 64, 40, 5, 65, 41], [5, 65, 41, 5, 66, 42],
    [7, 73, 45, 3, 74, 46], [10, 74, 46, 1, 75, 47], [9, 69, 43, 4, 70, 44],
    [3, 70, 44, 11, 71, 45], [3, 67, 41, 13, 68, 42], [17, 68, 42], [17, 74, 46],
    [4, 75, 47, 14, 76, 48], [6, 73, 45, 14, 74, 46], [8, 75, 47, 13, 76, 48],
    [19, 74, 46, 4, 75, 47], [22, 73, 45, 3, 74, 46], [3, 73, 45, 23, 74, 46],
    [21, 73, 45, 7, 74, 46], [19, 75, 47, 10, 76, 48], [2, 74, 46, 29, 75, 47],
    [10, 74, 46, 23, 75, 47], [14, 74, 46, 21, 75, 47], [14, 74, 46, 23, 75, 47],
    [12, 75, 47, 26, 76, 48], [6, 75, 47, 34, 76, 48], [29, 74, 46, 14, 75, 47],
    [13, 74, 46, 32, 75, 47], [40, 75, 47, 7, 76, 48], [18, 75, 47, 31, 76, 48],
  ],
};

// 校正图形中心坐标（ISO/IEC 18004 附录 E）。
const ALIGNMENT_PATTERN_TABLE = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const G15 = 0x0537;
const G18 = 0x1f25;
const G15_MASK = 0x5412;

function rsBlocksFor(version, level) {
  const table = level === EC_LEVEL_M ? RS_BLOCK_TABLE.M : RS_BLOCK_TABLE.L;
  const row = table[version - 1];
  if (!row) throw new Error(`二维码版本超出范围：${version}`);
  const blocks = [];
  for (let i = 0; i < row.length; i += 3) {
    for (let n = 0; n < row[i]; n += 1) {
      blocks.push({ totalCount: row[i + 1], dataCount: row[i + 2] });
    }
  }
  return blocks;
}

export function dataCapacityBytes(version, level) {
  return rsBlocksFor(version, level).reduce((sum, block) => sum + block.dataCount, 0);
}

// 版本 1-9 用 8 位长度指示符，10-26 用 16 位（字节模式）。
function lengthBits(version) {
  if (version < 10) return 8;
  if (version < 27) return 16;
  return 16;
}

function toUtf8Bytes(text) {
  const value = String(text == null ? '' : text);
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

// 选能装下的最小版本。容量按「数据码字」比较，长度指示符本身也占位，
// 所以必须把头部算进去再判——否则边界尺寸会在 make 时才炸。
export function pickVersion(byteLength, level) {
  for (let version = 1; version <= 40; version += 1) {
    const capacityBytes = dataCapacityBytes(version, level);
    const headerBits = 4 + lengthBits(version);
    if (headerBits + byteLength * 8 <= capacityBytes * 8) return version;
  }
  return -1;
}

class BitBuffer {
  constructor() {
    this.bytes = [];
    this.length = 0;
    this.value = 0;
  }

  put(value, bits) {
    for (let index = 0; index < bits; index += 1) {
      this.bit((value >>> (bits - index - 1)) & 1);
    }
  }

  bit(value) {
    this.value = ((this.value << 1) | value) & 0xff;
    if (this.length % 8 === 7) this.bytes.push(this.value);
    this.length += 1;
  }
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// 生成多项式 (x - a^0)(x - a^1)...(x - a^(degree-1))
function generatorPolynomial(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const generator = generatorPolynomial(degree);
  const buffer = new Array(data.length + degree).fill(0);
  for (let i = 0; i < data.length; i += 1) buffer[i] = data[i];
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i];
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j += 1) {
      buffer[i + j] ^= gfMul(generator[j], factor);
    }
  }
  return buffer.slice(data.length);
}

// 分块 → 交错。这是二维码纠错的核心布局：数据码字与纠错码字都要按
// 「第 i 块的第 j 个」顺序交错，读错顺序会导致扫不出来但看不出来。
function interleave(bytes, blocks) {
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  blocks.forEach(block => {
    const data = bytes.slice(offset, offset + block.dataCount);
    offset += block.dataCount;
    dataBlocks.push(data);
    ecBlocks.push(rsRemainder(data, block.totalCount - block.dataCount));
  });
  const out = [];
  const maxData = Math.max(...dataBlocks.map(block => block.length));
  for (let i = 0; i < maxData; i += 1) {
    dataBlocks.forEach(block => {
      if (i < block.length) out.push(block[i]);
    });
  }
  const maxEc = ecBlocks.length > 0 ? Math.max(...ecBlocks.map(block => block.length)) : 0;
  for (let i = 0; i < maxEc; i += 1) {
    ecBlocks.forEach(block => {
      if (i < block.length) out.push(block[i]);
    });
  }
  return out;
}

function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) {
    d ^= G15 << (bchDigit(d) - bchDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) {
    d ^= G18 << (bchDigit(d) - bchDigit(G18));
  }
  return (data << 12) | d;
}

function bchDigit(data) {
  let digit = 0;
  let value = data;
  while (value !== 0) {
    digit += 1;
    value >>>= 1;
  }
  return digit;
}

function maskAt(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
    default: throw new Error(`无效掩码：${pattern}`);
  }
}

function buildMatrix(version, level, codewords, maskPattern) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  const setupProbe = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= size) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        modules[row + r][col + c] = dark;
      }
    }
  };
  setupProbe(0, 0);
  setupProbe(size - 7, 0);
  setupProbe(0, size - 7);

  const positions = ALIGNMENT_PATTERN_TABLE[version - 1] || [];
  positions.forEach(row => {
    positions.forEach(col => {
      if (modules[row][col] !== null) return;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          modules[row + r][col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        }
      }
    });
  });

  for (let i = 8; i < size - 8; i += 1) {
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
  }

  const typeInfo = bchTypeInfo((level << 3) | maskPattern);
  for (let v = 0; v < 15; v += 1) {
    const dark = ((typeInfo >> v) & 1) === 1;
    if (v < 6) modules[v][8] = dark;
    else if (v < 8) modules[v + 1][8] = dark;
    else modules[size - 15 + v][8] = dark;
  }
  for (let h = 0; h < 15; h += 1) {
    const dark = ((typeInfo >> h) & 1) === 1;
    if (h < 8) modules[8][size - h - 1] = dark;
    else if (h < 9) modules[8][15 - h - 1 + 1] = dark;
    else modules[8][15 - h - 1] = dark;
  }
  modules[size - 8][8] = true;

  if (version >= 7) {
    const typeNumber = bchTypeNumber(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((typeNumber >> i) & 1) === 1;
      modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = dark;
    }
    for (let x = 0; x < 18; x += 1) {
      const dark = ((typeNumber >> x) & 1) === 1;
      modules[(x % 3) + size - 8 - 3][Math.floor(x / 3)] = dark;
    }
  }

  // 数据填充：从右下角起，两列一组蛇形向上，跳过第 6 列（时序图形）。
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (modules[row][col - c] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        }
        if (maskAt(maskPattern, row, col - c)) dark = !dark;
        modules[row][col - c] = dark;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return modules;
}

// 掩码罚分（ISO/IEC 18004 表 24 的四条规则），选罚分最低的掩码。
function lostPoint(modules) {
  const size = modules.length;
  let points = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const dark = modules[row][col];
      let sameCount = 0;
      for (let r = -1; r <= 1; r += 1) {
        if (row + r < 0 || row + r >= size) continue;
        for (let c = -1; c <= 1; c += 1) {
          if (col + c < 0 || col + c >= size) continue;
          if (r === 0 && c === 0) continue;
          if (dark === modules[row + r][col + c]) sameCount += 1;
        }
      }
      if (sameCount > 5) points += 3 + sameCount - 5;
    }
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      let count = 0;
      if (modules[row][col]) count += 1;
      if (modules[row + 1][col]) count += 1;
      if (modules[row][col + 1]) count += 1;
      if (modules[row + 1][col + 1]) count += 1;
      if (count === 0 || count === 4) points += 3;
    }
  }

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size - 6; col += 1) {
      if (
        modules[row][col]
        && !modules[row][col + 1]
        && modules[row][col + 2]
        && modules[row][col + 3]
        && modules[row][col + 4]
        && !modules[row][col + 5]
        && modules[row][col + 6]
      ) points += 40;
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size - 6; row += 1) {
      if (
        modules[row][col]
        && !modules[row + 1][col]
        && modules[row + 2][col]
        && modules[row + 3][col]
        && modules[row + 4][col]
        && !modules[row + 5][col]
        && modules[row + 6][col]
      ) points += 40;
    }
  }

  let darkCount = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (modules[row][col]) darkCount += 1;
    }
  }
  const ratio = Math.abs((100 * darkCount) / size / size - 50) / 5;
  points += ratio * 10;

  return points;
}

// 把文本编成二维码矩阵。
// 返回 { version, size, modules, level }；modules[row][col] 为 true 表示深色。
// 文本超出 40 版容量时抛错（由调用方决定怎么报给用户）。
export function encodeQr(text, options = {}) {
  const level = options.level === EC_LEVEL_M ? EC_LEVEL_M : EC_LEVEL_L;
  const bytes = toUtf8Bytes(text);
  const forced = Number.isFinite(options.minVersion) && options.minVersion > 0
    ? Math.min(40, Math.trunc(options.minVersion))
    : 1;
  const picked = pickVersion(bytes.length, level);
  if (picked < 0) {
    throw new Error(`内容过长，超出二维码容量（${bytes.length} 字节）`);
  }
  const version = Math.max(picked, forced);
  const blocks = rsBlocksFor(version, level);

  const buffer = new BitBuffer();
  buffer.put(4, 4); // 字节模式
  buffer.put(bytes.length, lengthBits(version));
  bytes.forEach(byte => buffer.put(byte, 8));

  const totalDataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
  const capacityBits = totalDataCount * 8;
  // 结束符最多 4 位（不足则按剩余位数补）
  const terminator = Math.min(4, capacityBits - buffer.length);
  if (terminator > 0) buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.bit(0);

  const dataBytes = buffer.bytes.slice();
  // 交替填充码字 0xEC / 0x11，直到填满数据容量
  let padToggle = 0;
  while (dataBytes.length < totalDataCount) {
    dataBytes.push(padToggle === 0 ? 0xec : 0x11);
    padToggle = padToggle === 1 ? 0 : 1;
  }

  const codewords = interleave(Uint8Array.from(dataBytes), blocks);

  let best = null;
  for (let pattern = 0; pattern < 8; pattern += 1) {
    const modules = buildMatrix(version, level, codewords, pattern);
    const points = lostPoint(modules);
    if (best === null || points < best.points) best = { points, modules, pattern };
  }
  return { version, size: version * 4 + 17, modules: best.modules, level, maskPattern: best.pattern };
}
