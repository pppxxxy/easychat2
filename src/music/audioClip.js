// 一起听歌「截取片段」：用隐藏 WebView 的 Web Audio 解码任意浏览器支持的音频格式
// （mp3/m4a/aac/ogg/flac/wav…），裁出从当前播放位置起的一小段并重编码为 16-bit PCM WAV。
// 只把 30 秒片段发给模型，绕开「整首歌超端点时长/体积上限」的问题。
//
// 本模块保持零 RN 依赖、纯字符串/纯函数，便于 Node 直测；真正跑在 WebView 里的脚本
// 由 encodeWavFromPcm / resampleToMono 的函数源码（Function.prototype.toString）注入，
// 保证「被测试的代码」与「运行的代码」是同一份，避免两处实现漂移。

// 片段时长：从当前播放位置起 30 秒。
export const CLIP_DURATION_MS = 30000;
// 统一重采样为 16kHz 单声道：足够理解歌词/旋律，30 秒约 0.96MB，base64 约 1.3MB。
export const CLIP_SAMPLE_RATE = 16000;

// Float32 样本（任意采样率、多声道）→ 16kHz 单声道 Int16 交错？此处输出单声道 Float32。
// 线性插值重采样，质量足够片段识别使用。纯函数，源码会被注入 WebView。
export function resampleToMono(channels, inputRate, outputRate) {
  const list = Array.isArray(channels) ? channels : [];
  const frames = list.length > 0 ? list[0].length : 0;
  if (frames === 0 || !inputRate || !outputRate) return new Float32Array(0);
  const outLength = Math.max(1, Math.floor((frames * outputRate) / inputRate));
  const out = new Float32Array(outLength);
  const ratio = inputRate / outputRate;
  const channelCount = list.length;
  for (let index = 0; index < outLength; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(left + 1, frames - 1);
    const fraction = sourcePosition - left;
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = list[channel];
      const a = data[left] || 0;
      const b = data[right] || 0;
      sum += a + (b - a) * fraction;
    }
    out[index] = sum / channelCount;
  }
  return out;
}

// Float32 [-1,1] 单声道样本 → 16-bit PCM WAV 的 DataView。
// 纯函数，源码会被注入 WebView。返回 ArrayBuffer。
export function encodeWavFromPcm(samples, sampleRate) {
  const length = samples.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (let index = 0; index < length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

// 构建隐藏 WebView 的 HTML。脚本只做三件事：收 base64 → 解码 → 裁段重编码 → 回传。
// 通过 window.ReactNativeWebView.postMessage 回传纯文本：'ok:<base64>' 或 'err:<消息>'。
export function buildAudioClipHtml() {
  const worker = [
    resampleToMono.toString(),
    encodeWavFromPcm.toString(),
  ].join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>
<script>
${worker}
(function () {
  function toArrayBuffer(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }
  function reply(text) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
  }
  window.__clipAudio = function (base64, startMs, durationMs, sampleRate) {
    try {
      var buffer = toArrayBuffer(base64);
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { reply('err:no-audiocontext'); return; }
      var ctx = new Ctx();
      ctx.decodeAudioData(buffer).then(function (decoded) {
        try {
          var startFrame = Math.max(0, Math.floor((startMs / 1000) * decoded.sampleRate));
          var clipFrames = Math.max(1, Math.floor((durationMs / 1000) * decoded.sampleRate));
          var endFrame = Math.min(decoded.length, startFrame + clipFrames);
          var channels = [];
          for (var c = 0; c < decoded.numberOfChannels; c += 1) {
            channels.push(decoded.getChannelData(c).subarray(startFrame, endFrame));
          }
          var mono = resampleToMono(channels, decoded.sampleRate, sampleRate);
          var wav = encodeWavFromPcm(mono, sampleRate);
          reply('ok:' + toBase64(wav));
        } catch (inner) {
          reply('err:' + (inner && inner.message ? inner.message : 'encode'));
        } finally {
          if (ctx.close) { try { ctx.close(); } catch (e) {} }
        }
      }).catch(function (error) {
        reply('err:' + (error && error.message ? error.message : 'decode'));
      });
    } catch (error) {
      reply('err:' + (error && error.message ? error.message : 'unknown'));
    }
  };
  reply('ready');
})();
</script>
</body></html>`;
}
