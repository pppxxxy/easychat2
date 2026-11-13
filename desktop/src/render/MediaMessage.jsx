// 媒体消息渲染（图片 / 表情包 / 视频占位）。
//
// 数据形态与 Android 端一致：message.image = { uri, mime, name, width, height,
// stickerId?, stickerName? }，数据库里仍存 file:// URI；渲染前经 mediaUrl()
// 转成 easychat2-media://（见 platform/mediaUrl.js）。
//
// 缺失兜底（Requirement 7.5）：URI 不在允许目录、或 <img> 加载失败时，渲染占位块，
// 不整条消息消失——媒体消息的 text 本来就是空串，静默返回 null 等于吞消息。
//
// 视频首版不做内嵌播放：主进程媒体协议是整文件读取、不支持 Range，Chromium 对
// 无 Range 的 <video> 支持不稳定。按 Android 端「交给系统」的同款口径，点卡片用
// 系统默认程序打开（app:openPath，主进程校验路径边界）。
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { VIDEO_MESSAGE_KIND } from '../../../src/chat/chatMedia.js';

function useMediaSource(uri) {
  return useMemo(() => {
    if (!uri) return null;
    const mapped = mediaUrl(uri);
    if (mapped) return mapped;
    // 非 documents/ 已知目录的 HTTP(S) 远程图（例如角色卡里的外链）直接交给 img，
    // 由 CSP 决定放不放行；其余本地路径不放行，走占位。
    return /^https?:/i.test(String(uri)) ? String(uri) : null;
  }, [uri]);
}

function Placeholder({ palette, fonts, name }) {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 14px',
      border: `1px dashed ${palette.divider}`,
      borderRadius: 10,
      color: palette.textMuted,
      minWidth: 180,
    }}
    >
      <span style={{ fontSize: 22, lineHeight: 1 }}>🖼</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: fonts.scaled(13), fontWeight: 700, color: palette.text }}>
          {name || t('chat.bubble.mediaMissing')}
        </span>
        <span style={{ fontSize: fonts.scaled(11) }}>{t('chat.bubble.mediaMissingHint')}</span>
      </span>
    </div>
  );
}

function Lightbox({ src, alt, fonts, onClose }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0,0,0,0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <img
        src={src}
        alt={alt}
        onClick={event => event.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8 }}
      />
      <button
        type="button"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 16,
          right: 20,
          background: 'rgba(255,255,255,0.14)',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '8px 14px',
          fontSize: fonts.scaled(13),
          cursor: 'pointer',
        }}
      >
        {t('chat.bubble.closePreview')}
      </button>
    </div>
  );
}

const IMAGE_MAX_WIDTH = 420;
const IMAGE_MAX_HEIGHT = 420;
const STICKER_SIZE = 128;

export default function MediaMessage({ image, kind, palette, fonts }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const src = useMediaSource(image && image.uri);
  const isVideo = kind === VIDEO_MESSAGE_KIND;
  const isSticker = !!image && (!!image.stickerId || kind === 'sticker');
  const name = String((image && (image.stickerName || image.name)) || '').trim();

  const openExternally = async () => {
    try {
      await getBridge().app.openPath(String(image && image.uri));
    } catch (error) {
      Alert.alert(t('chat.bubble.openFailed'));
    }
  };

  if (isVideo) {
    return (
      <button
        type="button"
        onClick={openExternally}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          maxWidth: 320,
          padding: '14px 16px',
          background: palette.surfaceAlt,
          border: `1px solid ${palette.divider}`,
          borderRadius: 10,
          color: palette.text,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 24, lineHeight: 1 }}>▶</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: fonts.scaled(13), fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name || t('chat.bubble.videoFallback')}
          </span>
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.bubble.videoOpen')}</span>
        </span>
      </button>
    );
  }

  if (!src || failed) {
    return <Placeholder palette={palette} fonts={fonts} name={name} />;
  }

  const ratio = Number(image && image.height) > 0 && Number(image && image.width) > 0
    ? Number(image.height) / Number(image.width)
    : 0.75;
  const naturalWidth = Number(image && image.width) || 0;
  // 小图不放大：48x36 的贴图如果按最大宽度撑满，会比原文大十倍。
  const width = isSticker
    ? STICKER_SIZE
    : Math.min(IMAGE_MAX_WIDTH, Math.max(48, Math.round(naturalWidth || 320)));
  const height = isSticker
    ? STICKER_SIZE
    : Math.min(IMAGE_MAX_HEIGHT, Math.max(24, Math.round(width * ratio)));

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6, maxWidth: '100%' }}>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        title={t('chat.bubble.imageA11y', { name: name || t('chat.bubble.unnamed') })}
        style={{
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'zoom-in',
          alignSelf: 'flex-start',
          lineHeight: 0,
        }}
      >
        <img
          src={src}
          alt={name || t('chat.bubble.imageA11y', { name: t('chat.bubble.unnamed') })}
          onError={() => setFailed(true)}
          style={{
            width,
            height,
            objectFit: 'contain',
            borderRadius: isSticker ? 8 : 10,
            background: isSticker ? 'transparent' : palette.surfaceAlt,
          }}
        />
      </button>
      {isSticker && name ? (
        <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted, textAlign: 'center' }}>{name}</span>
      ) : null}
      {previewOpen ? (
        <Lightbox
          src={src}
          alt={name}
          fonts={fonts}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </span>
  );
}
