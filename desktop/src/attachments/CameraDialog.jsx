// 相机（桌面）：拍照 / 录像，对应手机附件菜单里的「拍照」「拍摄视频」。
//
// 手机用 expo-image-picker / expo-camera；桌面渲染进程就是 Chromium，
// 等价物是 getUserMedia + canvas + MediaRecorder——都不需要额外原生依赖。
//
// 产出直接落进 documents/chat-images|chat-videos/，然后交给
// useDesktopAttachments.addCaptured 走既有的校验与追加链路（尺寸/上限/媒体保护
// 一处都不重写）。拍到的图与「对话框选的图」在后续环节完全等价。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export default function CameraDialog({ open, mode = 'photo', onClose, onCaptured, palette, fonts }) {
  const { t } = useTranslation();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [failed, setFailed] = useState('');

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch (error) {} });
    setReady(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setFailed('');
    const media = globalThis.navigator && globalThis.navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function') {
      setFailed(t('desktop.camera.unsupported'));
      return () => { alive = false; };
    }
    media.getUserMedia({ video: true, audio: mode === 'video' })
      .then(stream => {
        if (!alive) {
          stream.getTracks().forEach(track => { try { track.stop(); } catch (error) {} });
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setReady(true);
      })
      .catch(error => {
        if (!alive) return;
        // 没有摄像头 / 系统拒绝：如实说明，不装作「正在打开」。
        setFailed(String((error && error.message) || t('desktop.camera.unavailable')));
      });
    return () => {
      alive = false;
      stopStream();
    };
  }, [mode, open, stopStream, t]);

  const writeFile = useCallback(async (base64, ext) => {
    const bridge = getBridge();
    const kind = ext === 'webm' ? 'chat-videos' : 'chat-images';
    const dir = `${documentDirectory}${kind}/`;
    const name = `capture-${Date.now()}.${ext}`;
    const dest = `${dir}${name}`;
    await bridge.fs.mkdir(dir, true).catch(() => {});
    await bridge.fs.write(dest, base64, 'base64');
    markMediaWrite(dest);
    return { uri: dest, name, size: Math.round((base64.length * 3) / 4) };
  }, []);

  const shootPhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
      const file = await writeFile(base64, 'jpg');
      await onCaptured({ ...file, kind: 'image' });
      onClose();
    } catch (error) {
      Alert.alert(t('desktop.camera.captureFailed'));
    }
  }, [onCaptured, onClose, ready, t, writeFile]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || typeof globalThis.MediaRecorder !== 'function') {
      setFailed(t('desktop.camera.recorderUnsupported'));
      return;
    }
    chunksRef.current = [];
    const recorder = new globalThis.MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  }, [t]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    try { recorder.stop(); } catch (error) {}
    await stopped;
    setRecording(false);
    try {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const buffer = await blob.arrayBuffer();
      const file = await writeFile(base64FromArrayBuffer(buffer), 'webm');
      await onCaptured({ ...file, kind: 'video' });
      onClose();
    } catch (error) {
      Alert.alert(t('desktop.camera.captureFailed'));
    }
  }, [onCaptured, onClose, t, writeFile]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'video' ? t('chat.attach.videoCamera.title') : t('chat.attach.camera.title')}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, zIndex: 90,
      }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{
        width: 'min(680px, 94vw)', background: palette.surface, color: palette.text,
        border: `1px solid ${palette.divider}`, borderRadius: 14, padding: 16,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
      >
        <div style={{ fontSize: fonts.scaled(13), fontWeight: 700 }}>
          {mode === 'video' ? t('chat.attach.videoCamera.title') : t('chat.attach.camera.title')}
        </div>
        {failed ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{failed}</div>
        ) : (
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', borderRadius: 10, background: '#000', maxHeight: '56vh' }}
          />
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent', color: palette.textMuted,
              border: `1px solid ${palette.divider}`, borderRadius: 8,
              padding: '6px 14px', fontSize: fonts.scaled(12), cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!ready || !!failed}
            onClick={mode === 'video' ? (recording ? stopRecording : startRecording) : shootPhoto}
            style={{
              background: recording ? (palette.danger || '#ff5a5f') : palette.primary,
              color: palette.primaryContrast,
              border: 'none', borderRadius: 8, padding: '6px 14px',
              fontSize: fonts.scaled(12), cursor: ready ? 'pointer' : 'default',
              opacity: ready ? 1 : 0.6,
            }}
          >
            {mode === 'video'
              ? (recording ? t('desktop.camera.stopRecording') : t('desktop.camera.startRecording'))
              : t('desktop.camera.shoot')}
          </button>
        </div>
      </div>
    </div>
  );
}