// 桌面外壳结构守卫（S19）：语音两条线的可行性结论落地。
//
// 上一轮只把「语音播报」做了实现；录音与转写只被记成「不可用」，没做同等分析。
// 复核后的结论是两件不同的事：
//   · **转写可移植**：共享层 src/transcription.js 是纯 HTTP（POST /v1/audio/transcriptions），
//     不碰任何原生能力。真正的障碍是「渲染层 fetch 装不下 RN 形态的文件项」——
//     那是适配层的洞，已补（platform/fetch.js + 主进程 multipart + 目录白名单）。
//   · **录音不可移植**：共享层 useChatRecorder 的契约是 expo-audio 的 AudioRecorder
//     （recorder.uri / RecordingPresets），桌面没有对应实现。这与「不可移植」不同，
//     是真实的原生能力缺失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const CAPS = read('src', 'platform', 'capabilities.js');
const FETCH_ADAPTER = read('src', 'platform', 'fetch.js');
const POLYFILLS = read('src', 'polyfills.js');
const HTTP_IPC = read('electron', 'ipc', 'http.js');
const MAIN = read('electron', 'main.js');
const TRANSCRIPTION = readFileSync(
  path.resolve(DESKTOP, '..', 'src', 'transcription.js'),
  'utf8'
);

test('能力位：转写可用、录音不可用（两者结论不同，不能混成一句）', () => {
  assert.match(CAPS, /voiceTranscription: true/, '转写能力位应为 true');
  assert.match(CAPS, /voiceRecording: false/, '录音能力位应保持 false');
});

test('转写确实是纯 HTTP（这是它能移植的前提，必须由共享层源码作证）', () => {
  assert.ok(TRANSCRIPTION.includes('/v1/audio/transcriptions'), '端点应为 audio/transcriptions');
  assert.ok(TRANSCRIPTION.includes('fetch('), '应通过 fetch 发起');
  // 一旦共享层引入原生依赖（录音/编码），这条结论就过期了：让守卫先失败。
  assert.ok(!/expo-audio|react-native|NativeModules/.test(TRANSCRIPTION),
    '转写模块不应引入原生依赖；若引入了，能力位结论需要重新评估');
});

test('fetch 适配：FormData 文件项翻成 {path}，不静默发空请求', () => {
  assert.ok(FETCH_ADAPTER.includes('formDataToMultipart'), '缺 FormData 翻译');
  assert.ok(FETCH_ADAPTER.includes('_parts'), '应按 RN 的 _parts 形状识别 FormData');
  assert.ok(/cannot enumerate/.test(FETCH_ADAPTER), '枚举失败必须报错');
  assert.ok(/Blob uploads are not supported/.test(FETCH_ADAPTER), 'Blob 上传应明确拒绝');
  // 早到事件必须回放：丢了 status 会让 response.ok 永远 false。
  assert.ok(/pending\.push/.test(FETCH_ADAPTER), '缺早到事件缓存');
  assert.ok(FETCH_ADAPTER.includes('AbortError'), '缺 Abort 语义（转写靠它超时兜底）');
});

test('fetch 覆写装在 polyfills 里（与 XHR 同一处，先于共享层执行）', () => {
  assert.ok(POLYFILLS.includes('createFetch'), 'polyfills 未安装 fetch 适配');
  assert.ok(/globalThis\.fetch\s*=/.test(POLYFILLS), '未覆写 globalThis.fetch');
});

test('主进程 multipart：路径过白名单，未配 resolver 一律拒绝', () => {
  assert.ok(HTTP_IPC.includes('normalizeMultipart'), '缺 multipart 识别');
  assert.ok(HTTP_IPC.includes('buildMultipart'), '缺 multipart 组装');
  assert.ok(/multipart file upload requires a path resolver/.test(HTTP_IPC),
    '没有 resolver 时必须拒绝带文件的 multipart');
  assert.ok(/resolver\.resolve\(multipart\.file\.path\)/.test(HTTP_IPC), '文件路径未过白名单');
  assert.ok(MAIN.includes('resolver: fsService.resolver'), 'main 未把 resolver 传给 http 代理');
  // 头注入防护：CRLF 必须被剥掉（否则能伪造额外头部）。
  assert.ok(/replace\(\/\[\\r\\n"\]\/g, '_'\)/.test(HTTP_IPC), '文件名/字段名未剥 CRLF 与引号');
});

test('fetch 适配不破坏既有字符串体路径（api.js 的 JSON 请求）', () => {
  assert.ok(/String\(rawBody\)/.test(FETCH_ADAPTER), '非 FormData 体应原样字符串化');
  assert.ok(!/String\(rawBody\)[\s\S]{0,80}multipart/.test(FETCH_ADAPTER), '两条分支不得混用');
});