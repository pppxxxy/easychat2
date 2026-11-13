// 桌面语音播报适配层（platform/speech.js）的行为测试。
//
// 用假的 speechSynthesis / SpeechSynthesisUtterance 模拟 Chromium 行为，钉住三件
// 最容易出错、且出错后表现很隐蔽的事：
//   1. stop() 必须主动触发挂起那次的 onDone（Chromium 的 cancel 不触发 onend，
//      漏了会让上游的「正在播」状态永远不回收）；
//   2. rate 必须夹在 0.1..10（共享层可能传来任意正数）；
//   3. 空文本不产生播报（否则会有一段静默的「播报中」）。
import test from 'node:test';
import assert from 'node:assert/strict';

function makeRuntime() {
  const spoken = [];
  let cancelled = 0;
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const synth = {
    getVoices: () => [{ name: 'Microsoft Huihui', lang: 'zh-CN' }, { name: 'Zira', lang: 'en-US' }],
    addEventListener: () => {},
    speak: utterance => { spoken.push(utterance); },
    cancel: () => { cancelled += 1; },
  };
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  return { spoken, cancelledCount: () => cancelled };
}

// 每次测试都重新加载模块：模块内有 current / cachedVoices 状态。
async function loadSpeech() {
  const modulePath = '../../src/platform/speech.js';
  const url = new URL(modulePath, import.meta.url);
  url.search = `?t=${Math.random()}`;
  const mod = await import(url.href);
  return mod;
}

test('speak：正常发出并夹取倍速', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  speech.speak('你好', { rate: 99 });
  assert.equal(runtime.spoken.length, 1);
  assert.equal(runtime.spoken[0].text, '你好');
  assert.equal(runtime.spoken[0].rate, 10, '超过上限应夹到 10');
  speech.speak('慢一点', { rate: 0.001 });
  assert.equal(runtime.spoken[1].rate, 0.1, '低于下限应夹到 0.1');
});

test('speak：按名称匹配音色（含模糊匹配）', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  await speech.getAvailableVoicesAsync(); // 让语音列表就绪
  speech.speak('a', { voice: 'Zira' });
  assert.equal(runtime.spoken[0].voice && runtime.spoken[0].voice.name, 'Zira');
  speech.speak('b', { voice: 'Huihui' });
  assert.equal(runtime.spoken[1].voice && runtime.spoken[1].voice.name, 'Microsoft Huihui');
});

test('空文本不产生播报（避免一段静默的「播报中」）', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  speech.speak('');
  speech.speak('   ');
  speech.speak(null);
  assert.equal(runtime.spoken.length, 0);
});

test('stop：主动触发挂起的 onDone（Chromium 的 cancel 不触发 onend）', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  let done = 0;
  speech.speak('长文本', { onDone: () => { done += 1; } });
  assert.equal(done, 0);
  await speech.stop();
  assert.equal(runtime.cancelledCount(), 1, '应调用 cancel');
  assert.equal(done, 1, '必须自己收尾，否则上游永远认为还在播');
  // 再 stop 一次不应重复回调。
  await speech.stop();
  assert.equal(done, 1);
});

test('新的播报先打断旧的（一次只播一条）', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  let firstDone = 0;
  speech.speak('第一条', { onDone: () => { firstDone += 1; } });
  speech.speak('第二条');
  assert.equal(firstDone, 1, '旧的那次应被收尾');
  assert.equal(runtime.cancelledCount(), 1);
  assert.equal(runtime.spoken.length, 2);
});

test('utterance 结束触发 onDone；出错触发 onError', async () => {
  const runtime = makeRuntime();
  const speech = await loadSpeech();
  let done = 0;
  let failed = 0;
  speech.speak('x', { onDone: () => { done += 1; }, onError: () => { failed += 1; } });
  runtime.spoken[0].onend();
  assert.equal(done, 1);
  assert.equal(failed, 0);
  speech.speak('y', { onError: () => { failed += 1; } });
  runtime.spoken[1].onerror({ error: 'not-allowed' });
  assert.equal(failed, 1);
});

test('无 Web Speech 时 speak 抛错（由共享层的错误文案兜住）', async () => {
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
  const speech = await loadSpeech();
  assert.throws(() => speech.speak('x'), /not available/);
  // stop 在没有能力时应静默（不抛）。
  await speech.stop();
  assert.deepEqual(await speech.getAvailableVoicesAsync(), []);
});

// 共享层 tts/index.js 的系统引擎分支是用**运行时 require('expo-speech')** 取模块的
// （ESM 渲染进程没有 require）。polyfills 的白名单必须把它映射到本模块，否则
// getSpeechModule() 恒为 null、每次播报都抛「系统 TTS 不支持」——整条链路静默失效，
// 而单元测试全绿。这里直接把白名单的事实钉住。
test('polyfills 的 require 白名单把 expo-speech 映射到本模块', async () => {
  const fs = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await fs.readFile(
    fileURLToPath(new URL('../../src/polyfills.js', import.meta.url)),
    'utf8'
  );
  assert.match(source, /'expo-speech':\s*speech/, 'require("expo-speech") 必须落到 platform/speech.js');
});
