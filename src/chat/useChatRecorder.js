// 语音录制 hook：封装 expo-audio 的录制生命周期、麦克风权限、时长上下限与状态。
//
// 产出本地音频文件（documentDirectory/voice/<id>.m4a）与 { uri, durationMs, mime }，
// 交给转写与消息构造。录音与 TTS 播放互不干扰（各自的录制器/播放器）。
//
// expo-audio 的 useAudioRecorder 是组件级 hook，这里在 hook 顶层调用它，
// start/stop 内部再走命令式 prepare/record/stop。

import { useCallback, useEffect, useRef, useState } from 'react';

import { markMediaWrite } from '../mediaProtection.js';
import { getAudioModule, getFileSystem } from './audioModules.js';

const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 60 * 1000;

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
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    markMediaWrite(dest);
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
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef(null);
  const startedAtRef = useRef(0);

  const ensurePermission = useCallback(async () => {
    const lib = getAudioModule();
    if (!lib || typeof lib.requestRecordingPermissionsAsync !== 'function') {
      throw new Error('当前设备不支持录音');
    }
    const status = await lib.requestRecordingPermissionsAsync();
    if (!status || status.granted !== true) {
      throw new Error('需要麦克风权限才能发送语音');
    }
    return true;
  }, []);

  const start = useCallback(async () => {
    const audio = getAudioModule();
    if (!audio || !audio.AudioModule || typeof audio.AudioModule.AudioRecorder !== 'function') {
      throw new Error('当前设备不支持录音');
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

  // 结束录音：返回落盘后的音频描述；过短/过长则丢弃并抛错。
  const stop = useCallback(async () => {
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
    if (elapsed < MIN_DURATION_MS) {
      await discardFile(sourceUri);
      throw new Error('说话时间太短');
    }
    if (elapsed > MAX_DURATION_MS) {
      await discardFile(sourceUri);
      throw new Error('语音时长超限（最多 60 秒）');
    }
    const uri = await persistVoiceFile(sourceUri);
    return { uri, durationMs: elapsed, mime: 'audio/m4a' };
  }, []);

  const cancel = useCallback(async () => {
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
