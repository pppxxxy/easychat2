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

// —— 随机时段 + 风格权重（2026-10-11）——
// 同样只能源码断言：沙箱编译不了 Kotlin，真机后台触发由 CI/真机验证。
// 钉住的是「算错也不报错、只会静默发错」的几处：过期判据的基准、固定时刻路径不变、
// 占位符必须被替换掉、0 权重不参与抽取。

const scheduling = fs.readFileSync(
  path.resolve('plugins/proactiveMessage/android/ProactiveScheduling.kt'), 'utf8');

test('随机时段：nextTarget 在窗口内随机，isExpired 按「窗口结束 + 宽限」判定', () => {
  assert.ok(core.includes('const val MAX_WINDOW_MINUTES = 720'), '时段上限与 JS 侧一致（12 小时）');
  assert.ok(core.includes('val windowMinutes: Int = 0'), 'RoleSchedule 带 windowMinutes（0 = 旧行为）');
  assert.ok(/private fun pickInWindow\(/.test(core), '窗口内取随机时刻');
  assert.ok(/fun nextTarget\(config: RoleSchedule, random: Random = Random.Default\)/.test(core),
    'nextTarget 接受可注入的随机源（默认走系统随机）');
  // 今天窗口若已开始，只能在剩余区间里抽——否则会抽到过去，白白浪费今天的窗口
  assert.ok(core.includes('val lower = maxOf(dayStart, notBefore)'), '今天从 max(窗口起点, 现在) 起抽');
  // 过期判据必须落在「窗口结束 + 宽限」：拿抽中的随机时刻当基准，同一分钟内两次判定会不同
  assert.ok(/val deadline = start \+ windowSpan\(config\) \* 60_000L/.test(core), '过期基准 = 窗口起点 + 时段长度');
  assert.ok(core.includes('diff > MAX_LATENESS_MS'), '宽限沿用 30 分钟');
  // 固定时刻（span=0）路径逐字不变
  assert.ok(core.includes('if (span <= 0) return dayStart'), '固定时刻仍返回准点');
  assert.ok(core.includes('val start = todayTarget(config)'), '过期基准仍以准点为起点');
});

test('多风格：占位符常量与 JS 侧逐字一致，抽取只认正权重', () => {
  assert.ok(core.includes('const val PROACTIVE_TASK_TOKEN = "{{proactive_task}}"'), '占位符常量');
  assert.ok(core.includes('data class ProactiveVariant'), '抽取表条目类型');
  assert.ok(/fun pickVariant\(random: Random = Random.Default\)/.test(core), '按权重抽取');
  assert.ok(core.includes('variants.filter { it.weight > 0.0 }'), '0 权重不参与抽取');
  assert.ok(core.includes('val total = usable.sumOf { it.weight }'), '权重和由 JS 归一，这里只做累积比较');
  // 发送前必须把占位符替换掉（哪怕没抽到风格）——否则 {{…}} 会原样发给模型
  assert.ok(core.includes('schedule.requestJson.replace(PROACTIVE_TASK_TOKEN'), '替换占位符');
  assert.ok(core.includes('picked?.task ?: ""'), '没抽到风格也要把占位符换成空串');
  assert.ok(core.includes('effective.messageType'), '兜底文案用抽中的风格类型');
  assert.ok(core.includes('generateProactiveMessage(it, effective)'), '生成用的是替换后的请求体');
});

test('多风格：桥接解析 variantsJson 并夹住 windowMinutes；WORK 模式每天重抽', () => {
  assert.ok(module_.includes('private fun parseVariants'), 'JSON 字符串解析（数组跨 Interop 编组不可靠）');
  assert.ok(module_.includes('config.getString("variantsJson")'), '读 variantsJson');
  assert.ok(module_.includes('.coerceIn(0, MAX_WINDOW_MINUTES)'), 'windowMinutes 夹到合法区间');
  assert.ok(module_.includes('variants = parseVariants('), '抽取表接进 RoleSchedule');
  // 周期性任务会把首次随机偏移固定住，第二天起就不随机了——发完重排一次
  assert.ok(scheduling.includes('it.windowMinutes > 0'), '仅随机时段重排（固定时刻行为不变）');
  assert.ok(scheduling.includes('it.mode == ScheduleMode.WORK'), '只对 WorkManager 方案重排（精确闹钟本来就会重排）');
  // 落盘/读回要带上新字段，否则重启后窗口与风格表丢失
  assert.ok(core.includes('.put("windowMinutes", windowMinutes)'), 'toJson 写 windowMinutes');
  assert.ok(core.includes('.put("variants", JSONArray().apply'), 'toJson 写 variants');
  assert.ok(core.includes('json.optInt("windowMinutes", 0)'), 'fromJson 读 windowMinutes（缺省 = 旧行为）');
  assert.ok(core.includes('json.optJSONArray("variants")'), 'fromJson 读 variants');
});
