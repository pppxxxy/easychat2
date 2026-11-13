// 表情包面板：网格缩略图 + 导入入口；点缩略图直接发送。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { mediaUrl } from '../platform/mediaUrl.js';

function StickerTile({ sticker, palette, fonts, disabled, onSend }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(sticker.uri);
  return (
    <button
      type="button"
      onClick={() => onSend(sticker)}
      disabled={disabled}
      title={t('chat.sticker.sendA11y', { name: sticker.name })}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: 6,
        borderRadius: 10,
        border: `1px solid ${palette.divider}`,
        background: palette.surfaceAlt,
        cursor: disabled ? 'default' : 'pointer',
        minWidth: 0,
      }}
    >
      {failed || !src ? (
        <span style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>🖼</span>
      ) : (
        <img
          src={src}
          alt={sticker.name}
          onError={() => setFailed(true)}
          style={{ width: 56, height: 56, objectFit: 'contain' }}
        />
      )}
      <span style={{
        maxWidth: 72,
        fontSize: fonts.scaled(11),
        color: palette.textMuted,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      >
        {sticker.name}
      </span>
    </button>
  );
}

export default function StickerPanel({ stickers, palette, fonts, busy, disabled, onSend, onImport, onClose }) {
  const { t } = useTranslation();
  return (
    <div style={{
      borderTop: `1px solid ${palette.divider}`,
      background: palette.surface,
      padding: '10px 12px 12px',
      maxHeight: 240,
      overflow: 'auto',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: fonts.scaled(13), color: palette.text }}>{t('chat.sticker.title')}</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={onImport}
            disabled={disabled || busy}
            style={{
              background: palette.primary,
              color: palette.primaryContrast,
              border: 'none',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: fonts.scaled(12),
              fontWeight: 700,
              cursor: disabled || busy ? 'default' : 'pointer',
            }}
          >
            {busy ? t('chat.sticker.saving') : t('chat.sticker.add')}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('chat.sticker.closeA11y')}
            style={{
              background: 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '4px 9px',
              fontSize: fonts.scaled(12),
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      </div>
      {!Array.isArray(stickers) || stickers.length === 0 ? (
        <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12), padding: '8px 0' }}>
          {t('chat.sticker.empty')}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))',
          gap: 8,
        }}
        >
          {stickers.map(sticker => (
            <StickerTile
              key={sticker.id}
              sticker={sticker}
              palette={palette}
              fonts={fonts}
              disabled={disabled}
              onSend={onSend}
            />
          ))}
        </div>
      )}
    </div>
  );
}
