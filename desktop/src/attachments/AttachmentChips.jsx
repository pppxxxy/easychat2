// 输入区上方的待发送附件条：缩略图/文件名 + 移除按钮。
//
// 发送成功后 useChatSend 会清空 attachments，本组件自然消失；图片 URI 已落盘在
// chat-images/，移除时由 useDesktopAttachments 调共享的 deleteLocalImage 清理。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { mediaUrl } from '../platform/mediaUrl.js';

function Thumb({ item, palette }) {
  if (item.kind === 'text') {
    return (
      <span style={{
        width: 44,
        height: 44,
        borderRadius: 8,
        background: palette.surfaceAlt,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 20,
        flex: 'none',
      }}
      >
        📄
      </span>
    );
  }
  if (item.kind === 'video') {
    return (
      <span style={{
        width: 44,
        height: 44,
        borderRadius: 8,
        background: palette.surfaceAlt,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        flex: 'none',
      }}
      >
        🎬
      </span>
    );
  }
  const src = mediaUrl(item.uri);
  return (
    <img
      src={src || ''}
      alt=""
      style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8, flex: 'none', background: palette.surfaceAlt }}
    />
  );
}

export default function AttachmentChips({ attachments, palette, fonts, disabled, onRemove }) {
  const { t } = useTranslation();
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 12px 0' }}>
      {attachments.map(item => (
        <div
          key={item.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            maxWidth: 260,
            padding: '4px 6px 4px 4px',
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            background: palette.surface,
          }}
        >
          <Thumb item={item} palette={palette} />
          <span style={{
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
          >
            <span style={{
              fontSize: fonts.scaled(12),
              color: palette.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            >
              {item.name || t('chat.attach.unnamedFile')}
            </span>
            <span style={{ fontSize: fonts.scaled(10), color: palette.textMuted }}>
              {item.kind === 'text' ? t('chat.attach.text.title') : (item.kind === 'video' ? t('chat.bubble.videoFallback') : t('chat.attach.image.title'))}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            disabled={disabled}
            title={t('chat.attach.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: palette.textMuted,
              cursor: disabled ? 'default' : 'pointer',
              fontSize: 14,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
