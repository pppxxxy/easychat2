// 压缩关注点（桌面）：对应手机 chat/CompactFocusModal。
//
// 语义与 `/compact <关注点>` 完全一致：留空 = 与一键压缩逐字节相同
//（normalizeCompactionFocus 不追加那段 system 提示词），所以它只是多一次确认，
// 不改变「不想填」的体验。长度上限取共享层的 COMPACTION_FOCUS_MAX。
import { useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { COMPACTION_FOCUS_MAX } from '../../../src/chat/compaction.js';
import { Button } from '../settings/ui.jsx';

export default function CompactFocusDialog({ open, busy, onCancel, onConfirm, palette, fonts }) {
  const { t } = useTranslation();
  const [focus, setFocus] = useState('');

  // 每次打开清空：上一轮的关注点不该自动带到下一次压缩。
  useEffect(() => {
    if (open) setFocus('');
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(520px, 94vw)',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <strong style={{ fontSize: fonts.scaled(15) }}>{t('chat.compact.focus.title')}</strong>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {t('chat.compact.focus.hint')}
        </div>
        <textarea
          value={focus}
          onChange={event => setFocus(event.target.value.slice(0, COMPACTION_FOCUS_MAX))}
          placeholder={t('chat.compact.focus.placeholder')}
          rows={3}
          autoFocus
          disabled={busy}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            background: palette.surfaceAlt,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: fonts.scaled(12),
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button label={t('common.cancel')} onClick={onCancel} palette={palette} fonts={fonts} disabled={busy} />
          <Button
            label={busy ? t('chat.settings.compactBusy') : t('chat.compact.focus.confirm')}
            onClick={() => onConfirm(focus)}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy}
          />
        </div>
      </div>
    </div>
  );
}
