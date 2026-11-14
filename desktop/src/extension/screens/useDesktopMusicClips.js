// 音乐切片与自动评论（桌面）：对应手机「一起听歌」的 AudioClipWebView + 打点触发评论。
//
// 手机的做法：隐藏 WebView 跑 decodeAudioData → 裁 30 秒 → 重采样 16kHz 单声道 →
// 编码 WAV → base64 回传。桌面渲染进程本身就是 Chromium，**不需要 WebView**：
// 直接 AudioContext.decodeAudioData 拿到 AudioBuffer，再用共享纯函数
// resampleToMono / encodeWavFromPcm 做重采样与编码——两端的音频处理是同一条代码。
//
// 触发评论的判定也全在共享层：
//   · collectTriggersToCross / isSeekJump（music/triggers.js）——判断播放头跨过了哪些打点；
//   · buildTriggerCommentPrompt / buildOpeningCommentPrompt（music/commentPrompts.js）——
//     提示词构造，含「要不要带音频」。
// 本 hook 只负责「把判定接到 <audio> 的进度事件上」，不重写任何一条判定。
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CLIP_DURATION_MS,
  CLIP_SAMPLE_RATE,
  encodeWavFromPcm,
  resampleToMono,
} from '../../../../src/music/audioClip.js';
import {
  collectTriggersToCross,
  isSeekJump,
} from '../../../../src/music/triggers.js';

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // 分块拼接：一次 spread 大数组会爆调用栈（30 秒 WAV 约 96 万个采样点）。
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export default function useDesktopMusicClips({ onTriggerFired }) {
  const contextRef = useRef(null);
  const lastPositionRef = useRef(0);
  const [clipping, setClipping] = useState(false);

  // AudioContext 懒建：不播放就不该占音频设备。
  const getContext = useCallback(() => {
    if (contextRef.current) return contextRef.current;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    contextRef.current = new Ctor();
    return contextRef.current;
  }, []);

  useEffect(() => () => {
    const ctx = contextRef.current;
    contextRef.current = null;
    if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
  }, []);

  // 从当前曲目截一段 WAV（base64）。失败返回 null——调用方据此退回纯文字评论，
  // 与手机「裁剪不可用就退回整首/纯文字」同一策略。
  const clip = useCallback(async ({ url, startMs = 0 }) => {
    const ctx = getContext();
    if (!ctx || !url) return null;
    setClipping(true);
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const raw = await response.arrayBuffer();
      const audio = await ctx.decodeAudioData(raw.slice(0));
      const sampleRate = audio.sampleRate;
      const startFrame = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
      const lengthFrames = Math.min(
        audio.length - startFrame,
        Math.floor((CLIP_DURATION_MS / 1000) * sampleRate)
      );
      if (lengthFrames <= 0) return null;
      // 取出所有声道（decodeAudioData 已按源声道数解好）。
      const channels = [];
      for (let index = 0; index < audio.numberOfChannels; index += 1) {
        channels.push(audio.getChannelData(index).subarray(startFrame, startFrame + lengthFrames));
      }
      // 重采样与 WAV 编码都用共享纯函数（手机 WebView 里跑的是同一份代码）。
      const mono = resampleToMono(channels, sampleRate, CLIP_SAMPLE_RATE);
      const wav = encodeWavFromPcm(mono, CLIP_SAMPLE_RATE);
      return {
        base64: arrayBufferToBase64(wav),
        mime: 'audio/wav',
        durationMs: CLIP_DURATION_MS,
      };
    } catch (error) {
      return null;
    } finally {
      setClipping(false);
    }
  }, [getContext]);

  // 播放进度推进：判断这次跨过了哪些打点，逐个回调。
  // seek 跳转不算「播到」——手机 isSeekJump 同一判据（阈值 2500ms）。
  const onPositionChange = useCallback((positionMs, triggers) => {
    const previous = lastPositionRef.current;
    lastPositionRef.current = positionMs;
    if (!Array.isArray(triggers) || triggers.length === 0) return;
    if (isSeekJump(previous, positionMs)) return;
    const crossed = collectTriggersToCross(triggers, previous, positionMs);
    if (crossed.length === 0) return;
    if (typeof onTriggerFired === 'function') onTriggerFired(crossed, positionMs);
  }, [onTriggerFired]);

  const resetPosition = useCallback(() => { lastPositionRef.current = 0; }, []);

  return { clip, clipping, onPositionChange, resetPosition };
}
