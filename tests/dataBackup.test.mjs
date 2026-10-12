import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_MAX_BYTES,
  BACKUP_MEDIA_DIRECTORIES,
  buildBackupPayload,
  collectLockSecretIds,
  filterPendingMessages,
  isAllowedMediaPath,
  isQuickExportKey,
  isQuickExportMediaPath,
  planBackupImport,
  sanitizeAndFilterBackupValue,
  sanitizeBackupValue,
  scanSecretRefs,
  validateBackupPayload,
} from '../src/storage/dataBackup.js';

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
  assert.equal(isAllowedMediaPath('stickers/s.png'), true);
  assert.equal(isAllowedMediaPath('chat-images/i.jpg'), true);
  assert.equal(isAllowedMediaPath('voice/a.m4a'), true);
  assert.equal(isAllowedMediaPath('characters/a.json'), true);
  assert.equal(isAllowedMediaPath('card-forge/draft.json'), true);
  assert.equal(isAllowedMediaPath('music/song.mp3'), true);
  assert.equal(isAllowedMediaPath('books/b.txt'), true);
  assert.equal(isAllowedMediaPath('chat-videos/v.mp4'), true);
  assert.equal(isAllowedMediaPath('unknown/a.json'), false);
  assert.equal(isAllowedMediaPath('voice/../secret.txt'), false);
});

// P0 回归（2026-10）：白名单曾经**有两份**且已漂移——dataBackup.js 这份只有 6 项、缺
// music/books，于是音乐库与书籍在打包时被静默过滤（不进备份），恢复侧还会拒收含这些路径的包。
// 这里把「必须放行的目录」逐条钉住：删掉任何一项都会立刻变红。
test('媒体目录白名单：必须包含全部用户内容目录（9 项，删项即红）', () => {
  const required = [
    'avatars', 'stickers', 'chat-images', 'voice', 'characters',
    'card-forge', 'music', 'books', 'chat-videos',
  ];
  for (const dir of required) {
    assert.ok(BACKUP_MEDIA_DIRECTORIES.includes(dir), `${dir}/ 必须能被备份（缺了就是用户数据静默丢失）`);
  }
  assert.equal(new Set(BACKUP_MEDIA_DIRECTORIES).size, BACKUP_MEDIA_DIRECTORIES.length, '清单不得有重复项');
  assert.equal(Object.isFrozen(BACKUP_MEDIA_DIRECTORIES), true, '清单必须是冻结的常量，避免被运行时改写');
  // 刻意排除项（理由见 dataBackup.js 清单注释）：它们**不得**被顺手加回来
  for (const dir of ['screen-watch', 'local-models', '.transcripts', 'workspace']) {
    assert.equal(BACKUP_MEDIA_DIRECTORIES.includes(dir), false, `${dir}/ 属刻意排除项（见清单注释），不得登记`);
  }
});

// P0 回归：含 music/books/chat-videos 路径的备份包必须**既能打包进去、又能通过导入校验**。
// 这正是「恢复侧拒收」的直接回归测试：旧白名单下 validateBackupPayload 会判 invalid。
test('回归：music/books/chat-videos 路径能打包进备份，也能通过导入校验', () => {
  const media = [
    { path: 'music/song.mp3', base64: 'AA==' },
    { path: 'books/novel/0001.txt', base64: 'BB==' },
    { path: 'chat-videos/v.mp4', base64: 'CC==' },
  ];
  const payload = buildBackupPayload({ appVersion: 'test', storage: [], media });
  assert.deepEqual(payload.media.map(item => item.path), media.map(item => item.path),
    'buildBackupPayload 不得丢掉这些目录的文件');
  const validation = validateBackupPayload(payload);
  assert.equal(validation.valid, true, `含 music/books/chat-videos 的备份包必须能通过校验：${validation.error}`);
  // 导入计划同样要放行（恢复侧第二道口径）
  const plan = planBackupImport(payload, 'merge');
  assert.equal(plan.valid, true);
  assert.equal(plan.media.length, 3);
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

test('buildBackupPayload：opaqueRaw 条目原样保留，不做脱敏/序列化', () => {
  const payload = buildBackupPayload({
    appVersion: 'v',
    storage: [
      { key: '@easychat2_good', value: { apiKey: 'hidden' } },
      { key: '@easychat2_broken', opaqueRaw: '{ bad json with apiKey sk-leak' },
    ],
    media: [],
  });
  const broken = payload.storage.find(i => i.key === '@easychat2_broken');
  assert.equal(broken.opaqueRaw, '{ bad json with apiKey sk-leak');
  assert.equal(broken.value, undefined);
  // 正常键仍走脱敏
  assert.equal(payload.storage.find(i => i.key === '@easychat2_good').value.apiKey, '');
});

test('validateBackupPayload：含 opaqueRaw 的条目通过；旧格式照常通过', () => {
  const withOpaque = {
    schemaVersion: 1,
    storage: [{ key: '@easychat2_broken', opaqueRaw: '{ bad' }],
    media: [],
  };
  assert.equal(validateBackupPayload(withOpaque).valid, true);
  const legacy = { schemaVersion: 1, storage: [{ key: '@easychat2_a', value: {} }], media: [] };
  assert.equal(validateBackupPayload(legacy).valid, true);
});

test('planBackupImport：opaqueRaw 条目透传，不做结构化清理', () => {
  const plan = planBackupImport({
    schemaVersion: 1,
    storage: [
      { key: '@easychat2_broken', opaqueRaw: '{ bad', value: { apiKey: 'sk-leak', pending: true } },
    ],
    media: [],
  });
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.storage[0], { key: '@easychat2_broken', opaqueRaw: '{ bad' });
});

test('isQuickExportKey：命中角色卡与会话/消息/分支/记忆摘要，排除工作区与设置', () => {
  assert.equal(isQuickExportKey('@easychat2_character_index'), true);
  assert.equal(isQuickExportKey('@easychat2_character_item::c1'), true);
  assert.equal(isQuickExportKey('@easychat2_character_schedules'), true);
  assert.equal(isQuickExportKey('@easychat2_affinity'), true);
  assert.equal(isQuickExportKey('@easychat2_sessions'), true);
  assert.equal(isQuickExportKey('@easychat2_active_session'), true);
  assert.equal(isQuickExportKey('@easychat2_messages::s1'), true);
  assert.equal(isQuickExportKey('@easychat2_branch_index::s1'), true);
  assert.equal(isQuickExportKey('@easychat2_branch_item::s1::b1'), true);
  assert.equal(isQuickExportKey('@easychat2_session_summaries::s1'), true);
  // 排除：设置、工作区、本地模型、安全设置等
  assert.equal(isQuickExportKey('@easychat2_chat_options'), false);
  assert.equal(isQuickExportKey('@easychat2_api_configs'), false);
  assert.equal(isQuickExportKey('@easychat2_workspace_files'), false);
  assert.equal(isQuickExportKey('@easychat2_local_model'), false);
  assert.equal(isQuickExportKey('@easychat2_security'), false);
});

test('isQuickExportMediaPath：仅角色与聊天相关目录', () => {
  assert.equal(isQuickExportMediaPath('avatars/a.jpg'), true);
  assert.equal(isQuickExportMediaPath('characters/a.json'), true);
  assert.equal(isQuickExportMediaPath('chat-images/a.jpg'), true);
  assert.equal(isQuickExportMediaPath('voice/a.m4a'), true);
  assert.equal(isQuickExportMediaPath('stickers/a.png'), true);
  assert.equal(isQuickExportMediaPath('music/a.mp3'), false);
  assert.equal(isQuickExportMediaPath('books/a.epub'), false);
  assert.equal(isQuickExportMediaPath('card-forge/a.json'), false);
  assert.equal(isQuickExportMediaPath('characters/../secret.txt'), false);
});

test('完整导出媒体目录补齐 music/books（与采集清单对齐）', () => {
  assert.ok(BACKUP_MEDIA_DIRECTORIES.includes('music'));
  assert.ok(BACKUP_MEDIA_DIRECTORIES.includes('books'));
});

test('scanSecretRefs：找出引用密钥的键与去前缀 id', () => {
  const { keys, ids } = scanSecretRefs([
    { key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:apiConfigs_a_apiKey' }], activeId: 'a' } },
    { key: '@easychat2_tts', value: { nested: { token: 'secure:v1:tts_x' } } },
    { key: '@easychat2_plain', value: { note: 'no ref' } },
    { key: '@easychat2_broken', opaqueRaw: 'secure:v1:ghost' },
  ]);
  assert.deepEqual(keys.sort(), ['@easychat2_api_configs', '@easychat2_tts']);
  assert.deepEqual(ids.sort(), ['apiConfigs_a_apiKey', 'tts_x']);
});

test('collectLockSecretIds：从 security 键枚举角色锁密码与提示 id', () => {
  const ids = collectLockSecretIds({ appLock: { enabled: true }, characterLocks: { c1: true, c2: true } });
  assert.deepEqual(ids, ['character_lock_c1', 'character_lock_hint_c1', 'character_lock_c2', 'character_lock_hint_c2']);
  assert.deepEqual(collectLockSecretIds(null), []);
  assert.deepEqual(collectLockSecretIds({ appLock: {} }), []);
});

test('buildBackupPayload：携带密钥时保留 secure 引用并写入密钥清单', () => {
  const payload = buildBackupPayload({
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1', plain: 'keep' }] } }],
    media: [],
    mode: 'quick',
    secrets: [{ id: 'id1', value: 'sk-real' }],
  });
  assert.equal(payload.mode, 'quick');
  assert.equal(payload.secretsExcluded, false);
  assert.deepEqual(payload.secrets, [{ id: 'id1', value: 'sk-real' }]);
  assert.equal(payload.storage[0].value.configs[0].apiKey, 'secure:v1:id1');
  assert.equal(payload.storage[0].value.configs[0].plain, 'keep');
});

test('buildBackupPayload：不含密钥时维持剥离（secretsExcluded）', () => {
  const payload = buildBackupPayload({
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
    media: [],
  });
  assert.equal(payload.secretsExcluded, true);
  assert.equal(payload.storage[0].value.configs[0].apiKey, '');
  assert.equal(payload.secrets, undefined);
  assert.equal(payload.mode, 'full');
});

test('planBackupImport：含密钥时保留引用，不含时剥离', () => {
  const withSecrets = planBackupImport({
    schemaVersion: 1,
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
    media: [],
    secrets: [{ id: 'id1', value: 'sk-real' }],
  });
  assert.equal(withSecrets.storage[0].value.configs[0].apiKey, 'secure:v1:id1');
  assert.deepEqual(withSecrets.secrets, [{ id: 'id1', value: 'sk-real' }]);

  const without = planBackupImport({
    schemaVersion: 1,
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
    media: [],
  });
  assert.equal(without.storage[0].value.configs[0].apiKey, '');
  assert.deepEqual(without.secrets, []);
});

test('validateBackupPayload：密钥清单校验（可选、结构错误拒绝）', () => {
  const base = { schemaVersion: 1, storage: [], media: [] };
  assert.equal(validateBackupPayload({ ...base, secrets: [{ id: 'a', value: 'v' }] }).valid, true);
  assert.equal(validateBackupPayload(base).valid, true);
  assert.equal(validateBackupPayload({ ...base, secrets: 'nope' }).valid, false);
  assert.equal(validateBackupPayload({ ...base, secrets: [{ id: '', value: 'v' }] }).valid, false);
  assert.equal(validateBackupPayload({ ...base, secrets: [{ id: 'a', value: 1 }] }).valid, false);
});
// 回归 2026-10-11 逐行审查（顺带核对发现的第二条泄漏路径）：
// dataBackup 自带的 SECRET_FIELD_NAMES 注释写着「与 secretStore.SECRET_FIELDS 对齐」，
// 实际是另一份手写列表——漏了 githubToken / githubAccessToken / githubRefreshToken /
// mcpToken，也完全不认识 headers 这种对象形态的密钥字段。
// 于是「盘上只有引用」的保护被备份绕过：**旧明文数据**（从没被保险箱保护过）会被原样
// 写进备份包（实测 mcpToken / githubToken / headers 里的 Bearer token 都在）。
test('回归：备份脱敏口径必须覆盖保险箱保护的全部字段（不能只靠 secure:v1: 前缀兜底）', () => {
  // 对象形态的密钥字段**按域限定**（判据同 secretStore.js:87-92 isScopedSecretObject）：
  // 顶层存储键当 namespace 传进去，headers 只在 MCP 域才是密钥。
  const out = sanitizeBackupValue([{
    id: 'notes',
    mcpToken: 'zQ7mcptokenplain9x',
    githubToken: 'zQ7githubtokenplain9x',
    githubAccessToken: 'zQ7githubaccesstoken9x',
    githubRefreshToken: 'zQ7githubrefreshtoken9x',
    headers: { Authorization: 'Bearer zQ7headerplainsecretvalue9x' },
  }], '', '@easychat2_mcp_servers');
  assert.equal(out[0].mcpToken, '');
  assert.equal(out[0].githubToken, '');
  assert.equal(out[0].githubAccessToken, '');
  assert.equal(out[0].githubRefreshToken, '');
  // 对象形态的密钥字段：值全部清空、键名保留（用户恢复后知道要重填）
  assert.deepEqual(out[0].headers, { Authorization: '' });
  assert.equal(JSON.stringify(out).includes('zQ7'), false, '备份包里不得出现任何明文密钥');
});

test('对象形态密钥字段按域限定：别的域的同名 headers 不被清空（回归 17）', () => {
  const value = [{ id: 'x', headers: { 'X-Env': 'prod' } }];
  // MCP 域（含 `::` 分键形式）命中
  assert.deepEqual(sanitizeBackupValue(value, '', '@easychat2_mcp_servers')[0].headers, { 'X-Env': '' });
  assert.deepEqual(sanitizeBackupValue(value, '', '@easychat2_mcp_servers::a')[0].headers, { 'X-Env': '' });
  // 其它域（以及没给域）不命中：导出侧清多不清少虽安全，但恢复后用户会丢配置
  assert.deepEqual(sanitizeBackupValue(value, '', '@easychat2_other')[0].headers, { 'X-Env': 'prod' });
  assert.deepEqual(sanitizeBackupValue(value)[0].headers, { 'X-Env': 'prod' });
});

test('回归：合并遍历（导出路径）同样清空对象形态的密钥字段', () => {
  const payload = buildBackupPayload({
    storage: [{
      key: '@easychat2_mcp_servers',
      value: [{ id: 'notes', headers: { Authorization: 'Bearer zQ7headerplainsecretvalue9x' } }],
    }],
    media: [],
  });
  assert.deepEqual(payload.storage[0].value[0].headers, { Authorization: '' });
  assert.equal(JSON.stringify(payload).includes('zQ7header'), false);
});
