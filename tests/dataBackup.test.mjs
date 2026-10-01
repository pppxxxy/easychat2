import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_MAX_BYTES,
  buildBackupPayload,
  filterPendingMessages,
  isAllowedMediaPath,
  planBackupImport,
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
