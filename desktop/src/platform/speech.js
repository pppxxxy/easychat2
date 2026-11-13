// expo-speech 适配：桌面用 Chromium 的 Web Speech API（speechSynthesis）。
//
// 为什么可以（此前写成 unsupported 是过度保守）：渲染进程就是 Chromium，
// speechSynthesis 是浏览器标准能力，Windows 上走系统 SAPI 语音。共享层 tts/index 的
// 「系统引擎」分支（engine: 'system'）只调 speak(text, {voice, rate, onDone, onError})，
// 契约与此完全对应，所以整条播报链路（含自动播报）在桌面直接可用。
//
// 三处平台差异必须显式处理：
//   1. **voices 是异步就绪的**：Chromium 首次 getVoices() 可能返回空数组，
//      需要等 voiceschanged 事件。这里缓存并等待，避免「第一次播报没声音」。
//   2. **onDone/onError 只能挂一个**：speechSynthesis 的 utterance 事件是每次新建的，
//      stop() 时必须主动触发挂起那次的 callback（否则上游的播放态永远不回收）。
//   3. **rate 是 0.1..10**：共享层可能传任意正数（TTS 设置的倍速），要夹取。
const synth = typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null;

// 语音列表：先取缓存，空则等一次 voiceschanged（最多 2 秒，超时按空处理——
// 没有语音列表也能播，只是不能按名字选音色）。
let cachedVoices = [];
let voicesPromise = null;

function loadVoices() {
  if (!synth || typeof synth.getVoices !== 'function') return Promise.resolve([]);
  const now = synth.getVoices();
  if (Array.isArray(now) && now.length > 0) {
    cachedVoices = now;
    return Promise.resolve(now);
  }
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise(resolve => {
    let settled = false;
    const finish = list => {
      if (settled) return;
      settled = true;
      cachedVoices = Array.isArray(list) ? list : [];
      resolve(cachedVoices);
    };
    const timer = setTimeout(() => finish(synth.getVoices()), 2000);
    const onChanged = () => {
      clearTimeout(timer);
      finish(synth.getVoices());
    };
    try {
      synth.addEventListener('voiceschanged', onChanged, { once: true });
    } catch (error) {
      // 极老实现只有 onvoiceschanged 属性。
      synth.onvoiceschanged = onChanged;
    }
  });
  return voicesPromise;
}

// 正在播的那一条（stop() 需要它来收尾回调）。
let current = null;

function finishCurrent(kind, error) {
  const entry = current;
  current = null;
  if (!entry) return;
  const callback = kind === 'error' ? entry.onError : entry.onDone;
  if (typeof callback === 'function') {
    try {
      callback(error);
    } catch (callbackError) {
      // 回调自身出错不能影响播报收尾。
    }
  }
}

export function speak(text, options = {}) {
  const content = String(text === null || text === undefined ? '' : text);
  if (!content.trim()) return;
  if (!synth || typeof synth.speak !== 'function') {
    // 极端环境（无 Web Speech）：按「不支持」抛出，由共享层的错误文案兜住。
    throw new Error('speech synthesis is not available in this runtime');
  }
  const opts = options && typeof options === 'object' ? options : {};
  // 新的播报先打断旧的：与共享层「一次只播一条」的语义一致。
  // 只在真有挂起项时打断——没在播还调 cancel 会多一次无意义的取消
  //（Chromium 里无害，但会让「取消次数」这类可观测事实失真）。
  if (current) stop();
  const utterance = new globalThis.SpeechSynthesisUtterance(content);
  const speed = Number(opts.rate);
  if (Number.isFinite(speed) && speed > 0) {
    utterance.rate = Math.min(10, Math.max(0.1, speed));
  }
  const voiceName = String(opts.voice || '').trim();
  if (voiceName) {
    // 用已就绪的列表按名称匹配；列表还没到就等到位再设（didStart 前设置仍有效）。
    const match = cachedVoices.find(voice => String(voice && voice.name || '') === voiceName)
      || cachedVoices.find(voice => String(voice && voice.name || '').includes(voiceName));
    if (match) utterance.voice = match;
  }
  current = { onDone: opts.onDone, onError: opts.onError, utterance };
  utterance.onend = () => finishCurrent('done');
  utterance.onerror = event => finishCurrent('error', new Error((event && event.error) || 'speech error'));
  synth.speak(utterance);
  // 若语音列表是空的，异步补一次（不影响本次播报，只让下次能选音色）。
  if (cachedVoices.length === 0) loadVoices().catch(() => {});
}

export async function stop() {
  const entry = current;
  current = null;
  // cancel 只调一次：无论有没有挂起的那次。
  if (synth && typeof synth.cancel === 'function') {
    try {
      synth.cancel();
    } catch (error) {}
  }
  // 主动 cancel 时 Chromium 不会触发 onend，必须自己收尾——
  // 否则上游（useChatTts）的播放态永远不回收，后续播报会被当成仍在播。
  if (entry && typeof entry.onDone === 'function') {
    try {
      entry.onDone();
    } catch (error) {}
  }
}

export async function getAvailableVoicesAsync() {
  const voices = await loadVoices();
  return voices.map(voice => ({
    identifier: String((voice && voice.name) || ''),
    name: String((voice && voice.name) || ''),
    language: String((voice && voice.lang) || ''),
    quality: 0,
  }));
}

export default { speak, stop, getAvailableVoicesAsync };
