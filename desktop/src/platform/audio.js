// expo-audio 适配（桌面）：用 HTMLAudioElement 实现共享层需要的最小播放器契约。
//
// 共享层 src/tts/index.js 的云端 TTS 分支只依赖四件事：
//   createAudioPlayer({ uri }) → player
//   player.addListener('playbackStatusUpdate', cb) → { remove() }
//   player.play() / player.pause() / player.remove()
//   事件回调收到 { didJustFinish }
// 这些在 DOM 里全都有对应物，所以**云端 TTS 在桌面上是可用的**，不是能力缺失：
//   · uri 是 `data:audio/mp3;base64,...`，HTMLAudioElement 原生支持 data URI；
//   · 播放结束用 'ended' 事件映射成 didJustFinish；
//   · 解码失败用 'error' 事件报出来（否则会静默无声，用户以为没反应）。
//
// 此前这个文件直接 throw 'voice playback is not available'，把「没接」写成了
// 「不可用」——而系统引擎（Web Speech）其实一直是好的，两处说法互相矛盾。
//
// 录音（requestRecordingPermissionsAsync 等）确实没有桌面实现，保持 unsupported：
// 共享层 useChatRecorder 的契约是 expo-audio 的录音 API，与播放是两件事。

function createPlayer({ uri } = {}) {
  // 渲染进程就是 Chromium：Audio 是全局构造器。用 globalThis 取，避免 lint 的
  // no-undef（本文件同时被 Node 侧的结构测试读，不假设存在 DOM 全局）。
  const AudioCtor = globalThis.Audio;
  if (typeof AudioCtor !== 'function') {
    const error = new Error('audio playback requires a DOM environment');
    error.code = 'CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const element = new AudioCtor();
  element.preload = 'auto';
  element.src = String(uri || '');
  const listeners = new Set();

  const emit = status => {
    listeners.forEach(listener => {
      try {
        listener(status);
      } catch (error) {
        // 订阅方自己抛错不该打断播放链路。
      }
    });
  };

  element.addEventListener('ended', () => emit({ didJustFinish: true, isLoaded: true, playing: false }));
  element.addEventListener('error', () => {
    const code = element.error ? element.error.code : 0;
    const error = new Error(`audio playback failed (code ${code})`);
    error.code = 'AUDIO_PLAYBACK_FAILED';
    emit({ didJustFinish: false, isLoaded: false, playing: false, error });
  });

  return {
    play() {
      // 自动播放策略：桌面端播放由用户动作（点播报）触发，允许；
      // 若被浏览器拦下，promise 会 reject，这里吞掉并交给 error 事件/调用方超时处理。
      const result = element.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    },
    pause() {
      try {
        element.pause();
      } catch (error) {}
    },
    remove() {
      try {
        element.pause();
      } catch (error) {}
      element.removeAttribute('src');
      try {
        element.load();
      } catch (error) {}
      listeners.clear();
    },
    addListener(eventName, listener) {
      if (eventName !== 'playbackStatusUpdate' || typeof listener !== 'function') {
        return { remove() {} };
      }
      listeners.add(listener);
      return {
        remove() {
          listeners.delete(listener);
        },
      };
    },
    get element() {
      return element;
    },
  };
}

export const createAudioPlayer = options => createPlayer(options);

export const setAudioModeAsync = async () => {};

// 录音仍未实现：显式报结构化错误，由 capabilities.js 的 voiceRecording=false 兜住界面。
export const requestRecordingPermissionsAsync = async () => ({ granted: false, status: 'denied' });

export default {
  createAudioPlayer,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
};
