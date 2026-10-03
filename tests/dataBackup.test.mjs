import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_MAX_BYTES,
  buildBackupPayload,
  filterPendingMessages,
  isAllowedMediaPath,
  planBackupImport,
  sanitizeAndFilterBackupValue,
  sanitizeBackupValue,
  validateBackupPayload,
} from '../src/dataBackup.js';

test('备份上限放宽到足以容纳多张大角色卡与媒体', () => {
  assert.ok(BACKUP_MAX_BYTES >= 1024 * 1024 * 1024, '上限应不低于 1GB');
});

test('sanitizeBackupValue：递归清除密钥字段与 secure 引用', () => {
  const value = sanitizeBackupValue({
    apiKey: 'secret',
    nested: { appSecretKey: 'secret-2', value: 'secure:v1:id', keep: 'ok' },
  });
  assert.deepEqual(value, {
    apiKey: '',
    nested: { appSecretKey: '', value: '', keep: 'ok' },
  });
});

test('脱敏按字段名精确匹配：maxTokens/apiKeyUrl 不被误清空', () => {
  const out = sanitizeAndFilterBackupValue({
    maxTokens: { enabled: true, value: 4000 },
    apiKeyUrl: 'https://platform.example',
    sampling: { tokenizer: 'x' },
    token: 'abc',
    apiKey: 'sk-secret',
  });
  // 含 token/apiKey 子串的正常字段必须保留
  assert.deepEqual(out.maxTokens, { enabled: true, value: 4000 });
  assert.equal(out.apiKeyUrl, 'https://platform.example');
  assert.equal(out.sampling.tokenizer, 'x');
  // 真正的密钥字段名仍要清空
  assert.equal(out.token, '');
  assert.equal(out.apiKey, '');
});

test('planBackupImport：导入同样过滤 pending 并剥离密钥', () => {
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

test('filterPendingMessages：递归过滤 pending 消息', () => {
  const value = filterPendingMessages({
    messages: [
      { id: 'm1', pending: true },
      { id: 'm2', pending: false },
    ],
  });
  assert.deepEqual(value.messages, [{ id: 'm2', pending: false }]);
});

test('媒体路径校验：只允许应用媒体目录且拒绝穿越', () => {
  assert.equal(isAllowedMediaPath('avatars/a.jpg'), true);
  assert.equal(isAllowedMediaPath('voice/a.m4a'), true);
  assert.equal(isAllowedMediaPath('characters/a.json'), true);
  assert.equal(isAllowedMediaPath('card-forge/draft.json'), true);
  assert.equal(isAllowedMediaPath('unknown/a.json'), false);
  assert.equal(isAllowedMediaPath('voice/../secret.txt'), false);
});

test('buildBackupPayload：带版本、标记密钥排除并过滤 pending', () => {
  const payload = buildBackupPayload({
    appVersion: '1.0.0',
    storage: [{ key: '@easychat2_messages::s1', value: {
      apiKey: 'hidden',
      messages: [{ id: 'pending', pending: true }, { id: 'saved' }],
    } }],
    media: [{ path: 'voice/v.m4a', base64: 'AA==' }],
  });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.secretsExcluded, true);
  assert.equal(payload.storage[0].value.apiKey, '');
  assert.deepEqual(payload.storage[0].value.messages, [{ id: 'saved' }]);
  assert.equal(payload.media.length, 1);
});

test('validateBackupPayload/planBackupImport：版本与结构校验，模式规范化', () => {
  const payload = buildBackupPayload({ storage: [], media: [] });
  assert.equal(validateBackupPayload(payload).valid, true);
  assert.equal(planBackupImport(payload, 'replace').mode, 'replace');
  assert.equal(planBackupImport(payload, 'other').mode, 'merge');
  assert.equal(validateBackupPayload({ ...payload, schemaVersion: 2 }).valid, false);
  assert.equal(validateBackupPayload({ ...payload, media: [{ path: '../x', base64: 'AA==' }] }).valid, false);
  assert.equal(validateBackupPayload({ ...payload, storage: [{ key: 'other_key', value: {} }] }).valid, false);
  assert.equal(validateBackupPayload({ ...payload, storage: [{ key: '@easychat2_x', value: {} }, { key: '@easychat2_x', value: {} }] }).valid, false);
});

test('sanitizeAndFilterBackupValue：单次遍历与两次分别调用等价', () => {
  const input = {
    apiKey: 'sk-secret',
    token: 'abc',
    messages: [
      { id: 1, text: 'hi' },
      { id: 2, pending: true, text: 'streaming' },
      { id: 3, text: 'ok', nested: { password: 'pw', keep: 'yes' } },
    ],
    secureRef: 'secure:v1:xyz',
    list: [{ pending: true }, { pending: false, note: 'keep' }, null],
  };
  const combined = sanitizeAndFilterBackupValue(input);
  const separate = filterPendingMessages(sanitizeBackupValue(input));
  assert.deepEqual(combined, separate);
  // 关键字段确认
  assert.equal(combined.apiKey, '');
  assert.equal(combined.token, '');
  assert.equal(combined.secureRef, '');
  assert.equal(combined.messages.length, 2, 'pending 消息应被过滤');
  assert.equal(combined.messages[1].nested.password, '');
  assert.equal(combined.messages[1].nested.keep, 'yes');
});

test('buildBackupPayload：合并递归后仍脱敏密钥并过滤 pending', () => {
  const payload = buildBackupPayload({
    appVersion: 'v',
    storage: [{ key: '@easychat2_messages::s1', value: [{ id: 'm1', text: 'x', pending: true }, { id: 'm2', text: 'y', apiKey: 'sk-1' }] }],
    media: [],
  });
  assert.equal(payload.storage[0].value.length, 1);
  assert.equal(payload.storage[0].value[0].id, 'm2');
  assert.equal(payload.storage[0].value[0].apiKey, '');
});
