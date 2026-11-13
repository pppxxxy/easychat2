// 开场白选择器（桌面）：与手机 GreetingPickerModal 同一套语义。
//
// 手机版是「新建对话前先选开场白」；桌面此前完全没有这一步，于是「+」建出的会话
// greetingSelected=false，共享发送链路（useChatSend）有一条硬闸
// `if (!isGroup && !greetingReady) return false;` —— 新会话发不出消息且无任何提示。
// 本面板就是补上那道缺失的闸门放行步骤。
//
// 两种用途（与手机 purpose 对应）：
//   · new      新建对话：选完先写回角色卡，再以所选开场白建会话；
//   · reselect 重选：只替换当前会话里的开场白消息，不动其它消息。
import { useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { removeGreetingDraftIndex } from '../../../src/character/cardGreetings.js';
import { Button } from '../settings/ui.jsx';

export default function GreetingPicker({
  open,
  purpose = 'new',
  candidates,
  initialSelectedIndex,
  palette,
  fonts,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const source = Array.isArray(candidates) ? candidates : [];

  // 每次打开都按候选重置（关闭期间的编辑不保留——与手机 useEffect 同口径）。
  useEffect(() => {
    if (!open) return;
    const initial = (Array.isArray(candidates) ? candidates : []).map(item => String((item && item.text) || ''));
    setDrafts(initial);
    const requested = Number.isInteger(initialSelectedIndex)
      ? initialSelectedIndex
      : (initial.length > 0 ? 0 : -1);
    setSelectedIndex(requested >= 0 && requested < initial.length ? requested : -1);
  }, [open, candidates, initialSelectedIndex]);

  if (!open) return null;

  const updateDraft = (index, value) => {
    setDrafts(current => current.map((item, position) => (position === index ? value : item)));
  };

  const addDraft = () => {
    setSelectedIndex(drafts.length);
    setDrafts(current => [...current, '']);
  };

  const removeDraft = index => {
    const next = drafts.filter((_, position) => position !== index);
    setDrafts(next);
    setSelectedIndex(previous => removeGreetingDraftIndex(previous, index, next.length));
  };

  const hint = purpose === 'reselect'
    ? t('greetingPicker.hintSelect')
    : source.length > 0
      ? t('greetingPicker.hintMultiple')
      : t('greetingPicker.hintEmpty');

  const rowStyle = active => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    flex: 1,
    minWidth: 0,
    background: active ? palette.surfaceAlt : 'transparent',
    border: `1px solid ${active ? palette.primaryMuted : 'transparent'}`,
  });

  const radio = active => (
    <span style={{ fontSize: 15, lineHeight: 1, color: active ? palette.primary : palette.textFaint }}>
      {active ? '●' : '○'}
    </span>
  );

  return (
    <div
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 52,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(560px, 94vw)',
          maxHeight: '88vh',
          overflow: 'auto',
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('greetingPicker.title')}</strong>
          <button
            type="button"
            onClick={() => { if (!busy) onCancel(); }}
            title={t('greetingPicker.closeA11y')}
            style={{ background: 'transparent', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: 16 }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>{hint}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* 「不使用开场白」也是有效选项：会话照样能建成，只是由用户先开口。 */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSelectedIndex(-1)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedIndex(-1); }}
            style={rowStyle(selectedIndex < 0)}
          >
            {radio(selectedIndex < 0)}
            <span style={{ fontSize: fonts.scaled(13) }}>{t('greetingPicker.none')}</span>
          </div>

          {drafts.map((text, index) => (
            <div key={`greeting-${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedIndex(index)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedIndex(index); }}
                  style={rowStyle(selectedIndex === index)}
                >
                  {radio(selectedIndex === index)}
                  <span style={{
                    fontSize: fonts.scaled(13),
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  >
                    {String(text || '').trim()
                      ? String(text)
                      : t('greetingPicker.emptyItem')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeDraft(index)}
                  disabled={busy}
                  title={t('greetingPicker.removeA11y')}
                  style={{
                    background: 'transparent',
                    color: palette.textMuted,
                    border: `1px solid ${palette.divider}`,
                    borderRadius: 8,
                    padding: '4px 8px',
                    cursor: busy ? 'default' : 'pointer',
                    fontSize: fonts.scaled(11),
                    flex: 'none',
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
              {selectedIndex === index ? (
                <textarea
                  value={text}
                  onChange={event => updateDraft(index, event.target.value)}
                  placeholder={t('greetingPicker.editPlaceholder')}
                  rows={4}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                    background: palette.surfaceAlt,
                    color: palette.text,
                    border: `1px solid ${palette.divider}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: fonts.scaled(13),
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div>
          <Button label={t('greetingPicker.add')} onClick={addDraft} palette={palette} fonts={fonts} disabled={busy} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button
            label={t('greetingPicker.cancel')}
            onClick={() => { if (!busy) onCancel(); }}
            palette={palette}
            fonts={fonts}
            disabled={busy}
          />
          <Button
            label={busy ? t('greetingPicker.saving') : t('greetingPicker.useThis')}
            onClick={() => onConfirm({ drafts, selectedIndex })}
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