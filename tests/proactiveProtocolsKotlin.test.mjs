// 主动消息多协议：Kotlin 侧源码断言（沙箱无法编译 Kotlin，Gradle 编译与真机
// 后台触发由 CI/真机验证）。spec：.monkeycode/specs/2026-10-04-proactive-multi-protocol/。
//
// 钉住的要点（每条对应一个真实故障）：
// 1. 回复解析必须按协议分派——只认 openai 形态时 anthropic/responses 后台会静默失败；
// 2. 鉴权头必须来自设置（anthropic 是 x-api-key 原值，写死 Bearer 会 401）；
// 3. 时间占位符必须对整份 body 替换（转换后可能落在 system/instructions，遍历
//    messages 的旧实现会漏掉）；
// 4. 回退简版必须按协议组体（快照缺失时非 openai 协议也不能发错形态）；
// 5. 持久化新键缺省 = openai 语义（旧版本数据升级不破坏）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const core = fs.readFileSync(path.resolve('plugins/proactiveMessage/android/ProactiveCore.kt'), 'utf8');
const module_ = fs.readFileSync(path.resolve('plugins/proactiveMessage/android/ProactiveMessageModule.kt'), 'utf8');

test('回复解析按协议分派：anthropic content[].text、responses output_text、openai choices', () => {
  assert.ok(core.includes('private fun extractReplyText(protocol: String'), '回复解析必须按 protocol 分派');
  assert.ok(/"anthropic" -> \{[\s\S]*?optJSONArray\("content"\)/.test(core), 'anthropic 解析 content[] 文本块');
  assert.ok(/"openai-responses" -> \{[\s\S]*?optJSONArray\("output"\)/.test(core), 'responses 解析 output[] 的 output_text');
  assert.ok(/else -> json\.getJSONArray\("choices"\)/.test(core), 'openai 走 choices[0].message.content');
});

test('请求头来自设置：authHeader/authScheme + 额外头，不再写死 Bearer', () => {
  assert.ok(
    /\.header\(settings\.authHeader\.ifBlank \{ "Authorization" \}, settings\.authScheme \+ settings\.apiKey\)/.test(core),
    '鉴权头名与前缀必须来自 ApiSettings',
  );
  assert.ok(core.includes('KEY_EXTRA_HEADERS') && core.includes('settings.extraHeadersJson'), '额外头（anthropic-version 等）必须可下发');
  assert.ok(!/\.header\("Authorization", "Bearer \$\{settings\.apiKey\}"\)/.test(core),
    '不得再写死 Authorization: Bearer（anthropic 会 401）');
});

test('时间占位符对整份 body 替换（快照已是完整请求体）', () => {
  assert.ok(/fun substituteProactiveTime\(bodyText: String\): String/.test(core), '替换函数必须作用于整份 body 文本');
  assert.ok(
    core.includes('substituteProactiveTime(bodyText).toRequestBody(JSON_MEDIA)'),
    '发送前必须对整份 body（含 elvis 快照/回退两分支）做替换并转成 RequestBody',
  );
  assert.ok(!/substituteProactiveTime\(messages/.test(core), '不得再遍历 messages（转换后 system/instructions 会漏）');
});

test('请求体类型正确：buildRequest 收 RequestBody（回归当前编译错误）', () => {
  assert.ok(core.includes('import okhttp3.RequestBody'), '必须导入 RequestBody 类型');
  assert.ok(
    /private fun buildRequest\(settings: ApiSettings, body: RequestBody\): Request/.test(core),
    'buildRequest 形参须为 RequestBody（否则 .post(String) 编译不过）',
  );
  assert.ok(core.includes('.post(body)'), 'post 必须传 RequestBody');
  assert.ok(!/\.post\(bodyText\)/.test(core), '不得再向 post 传 String');
});

test('回退简版按协议组体（快照缺失时非 openai 协议也不发错形态）', () => {
  assert.ok(core.includes('private fun buildFallbackBody(settings: ApiSettings'), '回退简版必须感知协议');
  assert.ok(/"anthropic" -> JSONObject\(\)[\s\S]*?"system", systemPrompt/.test(core), 'anthropic 回退体 system 提顶层');
  assert.ok(/"openai-responses" -> \{[\s\S]*?"input"/.test(core), 'responses 回退体走 input/instructions');
  assert.ok(core.includes('"max_output_tokens", PROACTIVE_MAX_TOKENS'), 'responses 用 max_output_tokens');
});

test('ApiSettings 与持久化：新字段带 openai 缺省，旧数据兼容', () => {
  assert.ok(
    /val protocol: String = "openai",[\s\S]*?val authHeader: String = "Authorization",[\s\S]*?val authScheme: String = "Bearer ",[\s\S]*?val extraHeadersJson: String = ""/.test(core),
    '新字段必须带 openai 语义默认值',
  );
  for (const key of ['KEY_PROTOCOL', 'KEY_AUTH_HEADER', 'KEY_AUTH_SCHEME', 'KEY_EXTRA_HEADERS']) {
    assert.ok(core.includes(`private const val ${key}`), `缺少持久化键 ${key}`);
  }
  assert.ok(core.includes('prefs.getString(KEY_PROTOCOL, "openai")'), '读取时缺省按 openai，升级兼容');
  assert.ok(module_.includes('protocol = config.getString("protocol") ?: "openai"'), '桥接读取新字段并给缺省');
});
