// FIX-5R：备份导入大文件读取的回归门禁。
//
// 真机现场：83MB 快速导出与 114MB 完整导出**都**挂在同一句「备份文件无法恢复」。
// 与导出模式/media 无关 ⇒ 纯体积问题。根因是读取只有一个无参数单发整读：
//   `FileSystem.readAsStringAsync(uri)`  → Android 上整文件进 Java 堆（byte[] + String 双份）
//   → 83MB 瞬时占 250MB 上下 → OutOfMemoryError → 被 Expo 54 bridgeless 兼容层包成通用文案。
// 而导出侧是流式分片写、BACKUP_MAX_BYTES 放行 2GB ⇒ **这个 app 能写出它自己读不回来的备份**。
//
// 本测试钉三件事：
//   1) 策略决策（纯函数）：小文件直读 / 大文件分片 / 超限明确拒绝；
//   2) 分片读的正确性：多字节字符跨片不得损坏（这是最容易被写错的地方）；
//   3) 就地脱敏与深拷贝**语义等价**（省掉一整份峰值，但绝不能改变脱敏结果）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_BYTES,
  DIRECT_READ_MAX_BYTES,
  IMPORT_MAX_BYTES,
  decideReadStrategy,
  formatMegabytes,
  readBackupText,
  readChunkedText,
} from '../src/storage/backupRead.js';
import { planBackupImport, sanitizeAndFilterBackupValue } from '../src/storage/dataBackup.js';

// ---------- 策略决策 ----------

test('decideReadStrategy：小于直读上限走单发整读', () => {
  for (const size of [0, 1024, 1024 * 1024, DIRECT_READ_MAX_BYTES]) {
    const d = decideReadStrategy(size);
    assert.equal(d.strategy, 'direct', `${size} 应直读`);
    assert.equal(d.chunkCount, 0);
  }
});

test('decideReadStrategy：超过直读上限走分片，并给出片数', () => {
  // 83MB 是真机实锤的失败尺寸，必须落在分片区间而不是被拒。
  const size = 83 * 1024 * 1024;
  const d = decideReadStrategy(size);
  assert.equal(d.strategy, 'chunked');
  assert.equal(d.bytes, size);
  assert.equal(d.chunkCount, Math.ceil(size / CHUNK_BYTES));
  assert.ok(d.chunkCount > 1, '分片数应大于 1');
});

test('decideReadStrategy：超过诚实上限必须明确拒绝（不再「静默读到一半死」）', () => {
  const d = decideReadStrategy(IMPORT_MAX_BYTES + 1);
  assert.equal(d.strategy, 'rejected');
  assert.equal(d.reason, 'too-large');
});

test('decideReadStrategy：边界刚好等于上限时放行（不是 > 就拒）', () => {
  assert.equal(decideReadStrategy(IMPORT_MAX_BYTES).strategy, 'chunked');
  assert.equal(decideReadStrategy(IMPORT_MAX_BYTES + 1).strategy, 'rejected');
});

test('decideReadStrategy：尺寸未知/非法时不拒绝用户，退回直读', () => {
  // 量不出尺寸（老 API、查询失败、NaN）时若能拒绝，用户就会因为「量不出来」而无法恢复。
  // 另外 Number(null) === 0、Number('') === 0，若不做前置判断会把「未知」谎报成「0 字节」。
  for (const bad of [null, undefined, '', NaN, 'x', -1, Infinity]) {
    const d = decideReadStrategy(bad);
    assert.equal(d.strategy, 'direct', `${String(bad)} 应退回直读`);
    assert.equal(d.bytes, null, `${String(bad)} 的 bytes 必须是 null（不能谎报 0）`);
  }
});

test('decideReadStrategy：参数可覆盖（阈值不是散落的魔数）', () => {
  const d = decideReadStrategy(5, { directMaxBytes: 10, importMaxBytes: 100, chunkBytes: 4 });
  assert.equal(d.strategy, 'direct');
  const e = decideReadStrategy(20, { directMaxBytes: 10, importMaxBytes: 100, chunkBytes: 4 });
  assert.equal(e.strategy, 'chunked');
  assert.equal(e.chunkCount, 5);
  assert.equal(decideReadStrategy(200, { importMaxBytes: 100 }).strategy, 'rejected');
});

test('formatMegabytes：按 MB 取整（文案里给用户看的数字）', () => {
  assert.equal(formatMegabytes(0), 0);
  assert.equal(formatMegabytes(83 * 1024 * 1024), 83);
  assert.equal(formatMegabytes(512 * 1024 * 1024), 512);
  // 不足 1MB 也要是 0 而不是 NaN/小数
  assert.equal(formatMegabytes(1024), 0);
  assert.equal(formatMegabytes(null), 0);
});

// ---------- 分片读的正确性 ----------

// 假的 FileHandle：按 offset 顺序吐字节，模拟 RandomAccessFile。
function makeHandle(bytes, { onClose = null } = {}) {
  return {
    open() {
      let offset = 0;
      return {
        readBytes(length) {
          const slice = bytes.slice(offset, offset + length);
          offset += slice.length;
          return slice;
        },
        close() { if (onClose) onClose(); },
      };
    },
  };
}

// 测试用的「让出事件循环」：生产的 setTimeout(0) 在「1 字节一片」这类跨片边界下会积累
// 上千次宏任务（实测把两条测试拖到 76s / 30s）。这里换成立即 resolve，
// 被验证的逻辑（跨片增量解码）完全不变，只是不把测试拖慢。
const fastYield = () => Promise.resolve();

test('readChunkedText：分片拼回的内容与原文逐字节一致（纯 ASCII）', async () => {
  const text = 'a'.repeat(1000) + '{"k":"v"}';
  const bytes = Buffer.from(text, 'utf8');
  const result = await readChunkedText({
    handle: makeHandle(bytes),
    uri: 'file:///x.json',
    size: bytes.length,
    chunkBytes: 64,
    yieldToEventLoop: fastYield,
  });
  assert.equal(result.text, text);
  assert.equal(result.strategy, 'chunked');
  assert.ok(result.chunkCount > 1);
});

test('readChunkedText：多字节 UTF-8 跨片不得损坏（最关键的一条）', async () => {
  // 这是分片读最容易写错的地方：片尾切开一个汉字。必须有 `{ stream: true }`，
  // 否则解码器会把半个序列替换成 U+FFFD —— 数据静默损坏，而 JSON.parse 可能仍然成功。
  const text = '汉字测试'.repeat(200); // 每个汉字 3 字节
  const bytes = Buffer.from(text, 'utf8');
  // 刻意用不是 3 的倍数的片长，保证切点落在汉字中间
  for (const chunkBytes of [1, 2, 4, 5, 7, 64]) {
    const result = await readChunkedText({
      handle: makeHandle(bytes),
      uri: 'file:///x.json',
      size: bytes.length,
      chunkBytes,
      yieldToEventLoop: fastYield,
    });
    assert.equal(result.text, text, `chunkBytes=${chunkBytes} 时跨片字符被破坏`);
    assert.equal(result.text.includes('\uFFFD'), false, `chunkBytes=${chunkBytes} 出现替换字符`);
  }
});

test('readChunkedText：emoji（星平面，4 字节）跨片同样不得损坏', async () => {
  const text = '😀🎉🚀'.repeat(100);
  const bytes = Buffer.from(text, 'utf8');
  for (const chunkBytes of [1, 3, 5, 8]) {
    const result = await readChunkedText({
      handle: makeHandle(bytes),
      uri: 'file:///x.json',
      size: bytes.length,
      chunkBytes,
      yieldToEventLoop: fastYield,
    });
    assert.equal(result.text, text, `chunkBytes=${chunkBytes} 时 emoji 被破坏`);
  }
});

test('readChunkedText：size 为空时靠 EOF 停（老 API 量不到尺寸的情形）', async () => {
  const text = '{"a":1}';
  const bytes = Buffer.from(text, 'utf8');
  const result = await readChunkedText({
    handle: makeHandle(bytes),
    uri: 'file:///x.json',
    size: null,
    chunkBytes: 4,
    yieldToEventLoop: fastYield,
  });
  assert.equal(result.text, text);
});

test('readChunkedText：EOF 后不得空转（空片立即收尾）', async () => {
  // 若实现写成「空片也算一片、继续循环」，size 偏差时会死循环。
  const bytes = Buffer.from('abc', 'utf8');
  const result = await readChunkedText({
    handle: makeHandle(bytes),
    uri: 'file:///x.json',
    size: 999, // 故意比真实大
    chunkBytes: 2,
    yieldToEventLoop: fastYield,
  });
  assert.equal(result.text, 'abc');
});

test('readChunkedText：句柄一定被关闭（成功路径）', async () => {
  let closed = false;
  const bytes = Buffer.from('hello world', 'utf8');
  await readChunkedText({
    handle: makeHandle(bytes, { onClose: () => { closed = true; } }),
    uri: 'file:///x.json',
    size: bytes.length,
    chunkBytes: 4,
    yieldToEventLoop: fastYield,
  });
  assert.equal(closed, true, '成功路径也要关句柄（否则文件被占住）');
});

test('readChunkedText：读取报错时句柄也要关闭，且错误是 userFacing', async () => {
  let closed = false;
  const handle = {
    open() {
      let first = true;
      return {
        readBytes() {
          if (first) { first = false; return Buffer.from('ab', 'utf8'); }
          throw new Error('simulated read failure');
        },
        close() { closed = true; },
      };
    },
  };
  await assert.rejects(
    readChunkedText({ handle, uri: 'file:///x.json', size: 100, chunkBytes: 2, yieldToEventLoop: fastYield }),
    error => error && error.userFacing === true
  );
  assert.equal(closed, true, '出错路径同样要关句柄');
});

test('readChunkedText：无 FileHandle 时明确报错，不静默退回单发整读', async () => {
  // 静默退回单发整读 = 把要修的那个 OOM 又请回来。必须显式失败并说明原因。
  await assert.rejects(
    readChunkedText({ handle: null, uri: 'file:///x.json', size: 100 }),
    error => error && error.userFacing === true
  );
});

test('readChunkedText：onProgress 逐片上报，回调抛错不影响读取', async () => {
  const bytes = Buffer.from('x'.repeat(100), 'utf8');
  const seen = [];
  const result = await readChunkedText({
    handle: makeHandle(bytes),
    uri: 'file:///x.json',
    size: bytes.length,
    chunkBytes: 10,
    yieldToEventLoop: fastYield,
    onProgress: p => { seen.push(p); if (seen.length === 2) throw new Error('progress boom'); },
  });
  assert.equal(result.text, 'x'.repeat(100));
  assert.ok(seen.length >= 2);
  assert.equal(seen[0].bytes, 10);
  assert.equal(seen[0].total, 100);
  assert.equal(seen[0].chunks, 1);
});

// ---------- readBackupText：预检 + 分发 ----------

function makeLegacyFs({ size = null, text = '', exists = true, calls = [] } = {}) {
  return {
    async getInfoAsync() {
      calls.push('getInfo');
      if (size === 'throw') throw new Error('getInfo failed');
      return { exists, size: size == null ? undefined : size };
    },
    async readAsStringAsync() {
      calls.push('read');
      return text;
    },
  };
}

test('readBackupText：小文件走单发直读', async () => {
  const calls = [];
  const result = await readBackupText({
    uri: 'file:///small.json',
    legacyFs: makeLegacyFs({ size: 1024, text: '{"a":1}', calls }),
  });
  assert.equal(result.text, '{"a":1}');
  assert.equal(result.strategy, 'direct');
  assert.deepEqual(calls, ['getInfo', 'read']);
});

test('readBackupText：文件不存在 → userFacing 的「不可读或已被移动」', async () => {
  await assert.rejects(
    readBackupText({ uri: 'file:///gone.json', legacyFs: makeLegacyFs({ exists: false }) }),
    error => error && error.userFacing === true && /不可读或已被移动/.test(error.message)
  );
});

test('readBackupText：超限 → userFacing 且文案带具体 MB 与上限', async () => {
  const size = IMPORT_MAX_BYTES + 10 * 1024 * 1024; // 上限 + 10MB
  await assert.rejects(
    readBackupText({ uri: 'file:///huge.json', legacyFs: makeLegacyFs({ size }) }),
    error => {
      assert.equal(error.userFacing, true);
      // 必须同时给出实际大小与上限：只说「太大」用户无法判断该怎么办。
      // 期望值由 formatMegabytes 算出（不是手写常量），避免把测试自己的算术当成实现问题。
      assert.match(error.message, new RegExp(`${formatMegabytes(size)}MB`));
      assert.match(error.message, new RegExp(`${formatMegabytes(IMPORT_MAX_BYTES)}MB`));
      return true;
    }
  );
});

test('readBackupText：尺寸查不出来时不拒绝，仍尝试直读', async () => {
  const result = await readBackupText({
    uri: 'file:///unknown.json',
    legacyFs: makeLegacyFs({ size: null, text: '{"ok":1}' }),
  });
  assert.equal(result.text, '{"ok":1}');
  assert.equal(result.strategy, 'direct');
  assert.equal(result.bytes, null);
});

test('readBackupText：getInfoAsync 抛错 → 归成「不可读」，不把原生错误甩给用户', async () => {
  await assert.rejects(
    readBackupText({ uri: 'file:///x.json', legacyFs: makeLegacyFs({ size: 'throw' }) }),
    error => error && error.userFacing === true
  );
});

test('readBackupText：新 API 可用时大文件走分片，且用 File.size', async () => {
  const text = '汉'.repeat(500);
  const bytes = Buffer.from(text, 'utf8');
  const legacyFs = makeLegacyFs({ size: bytes.length, text: 'SHOULD-NOT-BE-USED' });
  class FakeFile {
    constructor(uri) { this.uri = uri; this.exists = true; this.size = bytes.length; }
    open() { return makeHandle(bytes).open(); }
  }
  const result = await readBackupText({
    uri: 'file:///big.json',
    legacyFs,
    nextFs: { File: FakeFile },
    directMaxBytes: 10, // 强制走分片
    chunkBytes: 7,
    yieldToEventLoop: fastYield,
  });
  assert.equal(result.text, text);
  assert.equal(result.strategy, 'chunked');
  assert.equal(result.text.includes('SHOULD-NOT-BE-USED'), false);
});

test('readBackupText：新 API 报 exists=false 时直接给「不可读或已被移动」', async () => {
  class FakeFile {
    constructor() { this.exists = false; this.size = 0; }
  }
  await assert.rejects(
    readBackupText({ uri: 'file:///gone.json', legacyFs: makeLegacyFs({}), nextFs: { File: FakeFile } }),
    error => error && error.userFacing === true
  );
});

// ---------- 就地脱敏：必须与深拷贝等价 ----------

test('就地脱敏与深拷贝结果完全一致（省内存但不能改语义）', () => {
  const make = () => ({
    apiKey: 'sk-leak',
    nested: { appSecretKey: 'x', keep: 'ok', deep: { token: 't', list: [{ pending: true, id: 1 }, { id: 2 }] } },
    headers: { Authorization: 'Bearer abc' },
    arr: [{ apiKey: 'a' }, { keep: 1 }],
    secure: 'secure:v1:ref',
  });
  const copied = sanitizeAndFilterBackupValue(make(), '', {});
  const inPlace = sanitizeAndFilterBackupValue(make(), '', { inPlace: true });
  assert.deepEqual(inPlace, copied, '就地改写的结果必须与深拷贝逐字段一致');
});

test('就地脱敏确实改写原对象（这正是省内存的来源）', () => {
  const original = { apiKey: 'sk-leak', keep: 1, list: [{ pending: true }, { id: 2 }] };
  const returned = sanitizeAndFilterBackupValue(original, '', { inPlace: true });
  assert.equal(returned, original, '应返回同一个对象引用（不新分配一棵树）');
  assert.equal(original.apiKey, '');
  assert.equal(original.list.length, 1, 'pending 元素应被原地移除');
  assert.equal(original.list[0].id, 2);
});

test('默认（不传 inPlace）不改写原对象——导出侧的值可能被别处引用', () => {
  const original = { apiKey: 'sk-leak', nested: { token: 't' } };
  const returned = sanitizeAndFilterBackupValue(original, '', {});
  assert.notEqual(returned, original, '默认必须返回新对象');
  assert.equal(original.apiKey, 'sk-leak', '原对象不得被改动');
  assert.equal(original.nested.token, 't');
  assert.equal(returned.apiKey, '');
  assert.equal(returned.nested.token, '');
});

test('keepSecrets 与 inPlace 组合：保留密钥时同样就地且不改值', () => {
  const original = { apiKey: 'sk-keep', headers: { Authorization: 'Bearer x' } };
  const returned = sanitizeAndFilterBackupValue(original, '', { keepSecrets: true, inPlace: true });
  assert.equal(returned, original);
  assert.equal(original.apiKey, 'sk-keep');
  assert.equal(original.headers.Authorization, 'Bearer x');
});

test('就地脱敏：数组里的 pending 过滤后长度正确（原地压实不留尾巴）', () => {
  const original = { list: [{ pending: true }, { id: 1 }, { pending: true }, { id: 2 }] };
  sanitizeAndFilterBackupValue(original, '', { inPlace: true });
  assert.equal(original.list.length, 2);
  assert.deepEqual(original.list.map(i => i.id), [1, 2]);
});

test('planBackupImport 走就地路径：脱敏结果与旧行为一致，且 pending 被丢弃', () => {
  const plan = planBackupImport({
    schemaVersion: 1,
    storage: [{
      key: '@easychat2_messages::s1',
      value: [
        { id: 'm1', text: '占位', pending: true },
        { id: 'm2', text: '真实', apiKey: 'sk-leak' },
      ],
    }],
    media: [],
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.storage[0].value.length, 1);
  assert.equal(plan.storage[0].value[0].id, 'm2');
  assert.equal(plan.storage[0].value[0].apiKey, '');
});

// ---------- 调用点：两个都必须换成新读取器 ----------
//
// 任务书要求「两个调用点一起换」。这条把它钉成结构性断言——而不是只靠人记得：
//   1) BackupPanel.handleImport（手动导入）
//   2) backup/autoBackupRun.js 的 readTextFile（**SAF 导出**搬运，不是恢复）
// 关键点：**不能再有无参数的单发整读**，那正是 OOM 的来源。

test('调用点 1：BackupPanel 的导入走 backupRead，不再无参数整读', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/BackupPanel.js', 'utf8');
  assert.match(source, /readBackupText\(/, 'BackupPanel 必须用 readBackupText');
  // 旧写法（无参数单发整读）必须消失——它的第二个参数是 undefined，是 OOM 的直接来源。
  assert.equal(
    /readAsStringAsync\(\s*picked\.assets\[0\]\.uri\s*\)/.test(source),
    false,
    '不得再对备份包做无参数 readAsStringAsync 整读'
  );
  // 解析后必须释放 raw（否则整段文本与解析结果同时常驻）
  assert.match(source, /raw = null;/, 'JSON.parse 后必须置 null 释放文本引用');
});

test('调用点 2：autoBackupRun 的 SAF 搬运读也走 backupRead', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/backup/autoBackupRun.js', 'utf8');
  assert.match(source, /readBackupText\(/, 'SAF 搬运读取必须用 readBackupText');
  assert.equal(
    /readAsStringAsync\(\s*uri\s*\)/.test(source),
    false,
    '不得再对整包做无参数 readAsStringAsync 整读'
  );
  // 依赖注入要能把新 API 传进来（否则分片读拿不到 FileHandle）
  assert.match(source, /nextFs/, 'deps 必须能注入新版 file system（分片读需要它）');
});

test('全仓：备份/自动备份路径里不再有「无参数 readAsStringAsync 整读」', async () => {
  // 广一点扫一遍：这两个文件是唯二会读到「整包」的地方。
  // 允许带 encoding 的调用（读图片/语音等，体积可控且不是整包 JSON）。
  const fs = await import('node:fs');
  for (const file of ['src/BackupPanel.js', 'src/backup/autoBackupRun.js']) {
    const source = fs.readFileSync(file, 'utf8');
    const bare = [...source.matchAll(/readAsStringAsync\(\s*([A-Za-z_$][\w$.\[\]]*)\s*\)/g)];
    assert.deepEqual(
      bare.map(m => m[0]),
      [],
      `${file} 仍有单参数 readAsStringAsync（会整文件进 Java 堆）：${bare.map(m => m[0]).join(', ')}`
    );
  }
});
