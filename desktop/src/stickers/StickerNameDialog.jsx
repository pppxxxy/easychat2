// 表情包命名对话框（桌面没有 Alert.prompt，用应用内模态）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { mediaUrl } from '../platform/mediaUrl.js';

export default function StickerNameDialog({ pending, nameDraft, palette, fonts, busy, onChange, onCancel, onSave }) {
  const { t } = useTranslation();
  if (!pending) return null;
  const src = mediaUrl(pending.uri);
  const submit = event => {
    event.preventDefault();
    if (!busy) onSave();
  };
  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 45,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <form
        onSubmit={submit}
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(420px, 90vw)',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 12,
          padding: 18,
          color: palette.text,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: fonts.scaled(15), marginBottom: 12 }}>
          {t('chat.sticker.title')}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {src ? (
            <img
              src={src}
              alt=""
              style={{ width: 72, height: 72, objectFit: 'contain', background: palette.surfaceAlt, borderRadius: 8, flex: 'none' }}
            />
          ) : null}
          <input
            autoFocus
            value={nameDraft}
            onChange={event => onChange(event.target.value)}
            placeholder={t('chat.sticker.namePlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              background: palette.surfaceAlt,
              color: palette.text,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '9px 10px',
              fontSize: fonts.scaled(13),
              outline: 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '7px 14px',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              background: palette.primary,
              color: palette.primaryContrast,
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? t('chat.sticker.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
