// 备份分块序列化的等价性守护：全部片段拼接必须与 JSON.stringify 逐字相同。
// 这是流式写盘正确性的根基——写盘方只负责把片段依次写入，语义由本模块保证。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_CHUNK_CHARS,
  createBackupChunkGenerator,
  createBackupChunks,
  utf8ByteLengthOfChunks,
} from '../src/storage/backupStream.js';

const join = payload => createBackupChunks(payload).join('');

test('分块拼接与 JSON.stringify 逐字等价（多种形状）', () => {
  const cases = [
    // 典型备份包形状
    {
      schemaVersion: 1,
      appVersion: '1.0.0',
      exportedAt: 1730000000000,
      secretsExcluded: true,
      storage: [
        { key: '@easychat2_characters', value: [{ id: 'c1', name: '中文角色' }] },
        { key: '@easychat2_settings', value: { keepDraft: false, nested: { deep: [1, null, 'x'] } } },
      ],
      media: [
        { path: 'avatars/c1.jpg', base64: 'AA==' },
        { path: 'voice/v1.m4a', base64: 'BBBB' },
      ],
    },
    // 空集合
    { schemaVersion: 1, appVersion: '', exportedAt: 0, secretsExcluded: true, storage: [], media: [] },
    // 值含 undefined（对象字段应被省略、数组元素应转 null）
    { a: undefined, b: [undefined, 1], c: null, d: 'str' },
    // 值含函数/symbol（应被省略）
    { a: 1, b: () => {}, c: Symbol('x') },
    // 转义与 Unicode 边界
    { text: '引号"反斜杠\\换行\n制表\t表情😀', astral: '𝄞' },
  ];
  for (const payload of cases) {
    assert.equal(join(payload), JSON.stringify(payload), `形状不一致：${JSON.stringify(payload)}`);
  }
});

test('单个超大 base64 被切成多片，拼接后仍逐字一致', () => {
  const big = 'A'.repeat(BACKUP_CHUNK_CHARS * 2 + 12345);
  const payload = {
    schemaVersion: 1,
    appVersion: 'x',
    exportedAt: 1,
    secretsExcluded: true,
    storage: [],
    media: [{ path: 'chat-images/big.png', base64: big }],
  };
  const chunks = createBackupChunks(payload);
  assert.ok(chunks.length >= 3, '超大 base64 应被切成多片');
  assert.equal(chunks.join(''), JSON.stringify(payload));
});

test('生成器惰性产出：不在首个片段前构造整包字符串', () => {
  const generator = createBackupChunkGenerator({
    schemaVersion: 1,
    appVersion: 'x',
    exportedAt: 1,
    secretsExcluded: true,
    storage: [],
    media: [],
  });
  const first = generator.next();
  assert.equal(first.value, '{', '首个片段应为顶层开括号');
  assert.equal(first.done, false);
});

test('非对象入参拒绝；字节统计与一次性统计等价', () => {
  assert.throws(() => createBackupChunks(null), /备份内容无效/);
  assert.throws(() => createBackupChunks([]), /备份内容无效/);
  const payload = {
    schemaVersion: 1,
    appVersion: '中文',
    exportedAt: 1,
    secretsExcluded: true,
    storage: [{ key: '@easychat2_a', value: { 值: '带表情😀' } }],
    media: [],
  };
  const chunks = createBackupChunks(payload);
  assert.equal(utf8ByteLengthOfChunks(chunks), Buffer.byteLength(JSON.stringify(payload), 'utf8'));
});
