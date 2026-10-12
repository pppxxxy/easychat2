// 语音录制 hook：封装 expo-audio 的录制生命周期、麦克风权限、时长上下限与状态。
//
// 时长口径在 voiceDuration.js（纯模块，可单测）：到 MAX_DURATION_MS 上限时本 hook 会
// **自动停止并保留**已录内容（此前是等用户按停后判超限、把整段删掉）。
//
// 产出本地音频文件（documentDirectory/voice/<id>.m4a）与 { uri, durationMs, mime }，
// 交给转写与消息构造。录音与 TTS 播放互不干扰（各自的录制器/播放器）。
//
// expo-audio 的 useAudioRecorder 是组件级 hook，这里在 hook 顶层调用它，
// start/stop 内部再走命令式 prepare/record/stop。

import { useCallback, useEffect, useRef, useState } from 'react';

import { markMediaWrite } from '../storage/mediaProtection.js';
import { getAudioModule, getFileSystem } from './audioModules.js';
import { useTranslation } from '../i18n/I18nContext.js';
// 时长口径是纯模块（voiceDuration.js）：这里只做接线，口径本身有独立单测。
import { MIN_DURATION_MS, MAX_DURATION_MS, classifyRecordingDuration } from './voiceDuration.js';

// 把录制临时文件搬到 documentDirectory/voice/ 并登记「刚写入」保护，
// 避免消息尚未落盘时被回收器误删。
async function persistVoiceFile(sourceUri) {
  const FileSystem = getFileSystem();
  if (!FileSystem || !sourceUri) return sourceUri;
  const dir = `${FileSystem.documentDirectory || ''}voice/`;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.m4a`;
    const dest = `${dir}${name}`;
    // 先登记保护再写盘：copy 与 mark 之间的 await 窗口若并发跑回收，
    // 这个刚写入、尚未被消息引用的文件会被当成孤儿删掉。
    markMediaWrite(dest);
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
    return dest;
  } catch (error) {
    return sourceUri;
  }
}

async function discardFile(uri) {
  if (!uri) return;
  getFileSystem()?.deleteAsync?.(uri, { idempotent: true }).catch(() => {});
}

export default function useChatRecorder() {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef(null);
  const startedAtRef = useRef(0);
  // 到上限的自动停止计时器：手动停 / 取消 / 卸载都必须清掉，否则会对着已停的录音再停一次。
  const autoStopTimerRef = useRef(null);

  const ensurePermission = useCallback(async () => {
    const lib = getAudioModule();
    if (!lib || typeof lib.requestRecordingPermissionsAsync !== 'function') {
      throw new Error(t('chat.voice.error.unsupported'));
    }
    const status = await lib.requestRecordingPermissionsAsync();
    if (!status || status.granted !== true) {
      throw new Error(t('chat.voice.error.micPermission'));
    }
    return true;
  }, [t]);

  const start = useCallback(async () => {
    // 已在录音就直接返回：重复 start 会换掉 recorderRef 里的录制器，而 effect 只在 recording
    // 变化时重挂计时器 ⇒ 新录音会失去自动停止（旧计时器认不出新录制器，自己短路）。
    if (recorderRef.current) return true;
    const audio = getAudioModule();
    if (!audio || !audio.AudioModule || typeof audio.AudioModule.AudioRecorder !== 'function') {
      throw new Error(t('chat.voice.error.unsupported'));
    }
    await ensurePermission();
    // 录制需放开录音模式（iOS）、允许静音模式下工作。
    try {
      await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    } catch (error) {}
    const recorder = new audio.AudioModule.AudioRecorder(audio.RecordingPresets.HIGH_QUALITY);
    await recorder.prepareToRecordAsync();
    recorder.record();
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setRecording(true);
    return true;
  }, [ensurePermission]);

  // 结束录音：返回落盘后的音频描述；过短则丢弃并抛错。
  const stop = useCallback(async () => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    try {
      getAudioModule()?.setAudioModeAsync({ allowsRecording: false }).catch?.(() => {});
    } catch (error) {}
    if (!recorder) return null;
    const elapsed = Date.now() - startedAtRef.current;
    try {
      await recorder.stop();
    } catch (error) {
      return null;
    }
    const sourceUri = String(recorder.uri || '');
    const duration = classifyRecordingDuration(elapsed);
    if (duration === 'tooShort') {
      await discardFile(sourceUri);
      throw new Error(t('chat.voice.error.tooShort'));
    }
    // 超上限**不 discard**：只提示，已录内容照常落盘返回（见 classifyRecordingDuration 的说明）。
    if (duration === 'tooLong') {
      throw new Error(t('chat.voice.error.tooLong'));
    }
    const uri = await persistVoiceFile(sourceUri);
    return { uri, durationMs: elapsed, mime: 'audio/m4a' };
  }, [t]);
  // 自动停止要调 stop 本身（否则拿不到 uri、也走不到落盘），故经 ref 转发，避开 useCallback 的自引用。
  const stopRef = useRef(null);
  stopRef.current = stop;

  // 到 60 秒上限**自动停止并保留**已录内容（推荐做法 a）。
  //
  // 为什么必须自动停：此前只在 stop() 里用 `elapsed > MAX` 判超限，而录音是用户按停才结束的
  // ⇒ 一到 60 秒，用户接着说话、最后按停，得到的是「语音时长超限」+ **整段被删**（discardFile）。
  // 而同一功能里「转写更长的音频」入口（pickAudioFile）根本没有时长上限——两条路径口径不一致，
  // 且代价全落在用户身上。自动停在到达上限时就定格，stop() 返回 uri，用户至少不丢内容。
  useEffect(() => {
    if (!recording) return undefined;
    const recorder = recorderRef.current;
    const timer = setTimeout(() => {
      autoStopTimerRef.current = null;
      // 手动停/取消已先跑过则 recorderRef 已清空，stop() 自行短路，不会二次停止。
      if (recorderRef.current === recorder) stopRef.current?.();
    }, MAX_DURATION_MS);
    autoStopTimerRef.current = timer;
    // 只清自己这一支：cleanup 跑完可能紧接着开始下一次录音，清 ref 会误杀新计时器。
    return () => {
      clearTimeout(timer);
      if (autoStopTimerRef.current === timer) autoStopTimerRef.current = null;
    };
  }, [recording]);

  const cancel = useCallback(async () => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!recorder) return;
    try {
      await recorder.stop();
    } catch (error) {}
    await discardFile(String(recorder.uri || ''));
  }, []);

  // 卸载时若仍在录音，必须停止并释放麦克风：否则录音会一直持有麦克风，
  // 用户离开聊天页后其它应用无法录音，且录制临时文件会残留。
  useEffect(() => () => {
    // 卸载时连自动停止计时器一起清掉：留着它会对着已释放的录音器再 stop 一次。
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    (async () => {
      try {
        await recorder.stop();
      } catch (error) {}
      await discardFile(String(recorder.uri || ''));
    })();
  }, []);

  return { recording, available: true, start, stop, cancel };
}

export { MIN_DURATION_MS, MAX_DURATION_MS };
