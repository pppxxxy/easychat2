// 桌面免责声明弹层：分节渲染 + 中/英切换（中文权威、英文参考译文并附提示）。
//
// 条款内容直接取共享层 disclaimerContent.js（权威文本，与 Android 完全同一份）；
// 语言默认跟随界面语言，切换只影响展示，不写存储（同意记录不区分语言）。
import { useEffect, useState } from 'react';

import {
  DISCLAIMER_EN_NOTICE,
  getDisclaimerSections,
} from '../../../src/onboarding/disclaimerContent.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';

function Section({ section, palette, fonts }) {
  return (
    <div style={{ marginTop: 14 }}>
      {section.title ? (
        <div style={{ fontSize: fonts.scaled(13), fontWeight: 800, color: palette.text, marginBottom: 6 }}>
          {section.title}
        </div>
      ) : null}
      {section.body ? (
        <div style={{ fontSize: fonts.scaled(12), lineHeight: 1.75, color: palette.textMuted, whiteSpace: 'pre-wrap' }}>
          {section.body}
        </div>
      ) : null}
      {(section.bullets || []).map((bullet, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <span style={{ color: palette.primaryMuted, lineHeight: 1.75 }}>•</span>
          <span style={{ fontSize: fonts.scaled(12), lineHeight: 1.75, color: palette.textMuted }}>{bullet}</span>
        </div>
      ))}
    </div>
  );
}

export default function DisclaimerDialog({ open, onClose, palette, fonts, acceptLabel }) {
  const { t, localeId } = useTranslation();
  const [lang, setLang] = useState(localeId === 'en' ? 'en' : 'zh-CN');

  useEffect(() => {
    if (open) setLang(localeId === 'en' ? 'en' : 'zh-CN');
  }, [open, localeId]);

  if (!open) return null;
  const sections = getDisclaimerSections(lang);
  const options = [
    { id: 'zh-CN', labelKey: 'settings.language.zh' },
    { id: 'en', labelKey: 'settings.language.en' },
  ];

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        width: 'min(720px, 94vw)',
        maxHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
        background: palette.surface,
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        padding: 18,
        color: palette.text,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <strong style={{ fontSize: fonts.scaled(16) }}>{t('onboarding.disclaimer.title')}</strong>
          <div style={{ display: 'flex', borderRadius: 999, border: `1px solid ${palette.divider}`, overflow: 'hidden' }}>
            {options.map(option => {
              const active = lang === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setLang(option.id)}
                  style={{
                    background: active ? palette.primary : 'transparent',
                    color: active ? palette.primaryContrast : palette.textMuted,
                    border: 'none',
                    padding: '5px 10px',
                    fontSize: fonts.scaled(12),
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, paddingRight: 6 }}>
          {sections.map((section, index) => (
            <Section key={section.title || index} section={section} palette={palette} fonts={fonts} />
          ))}
          {lang === 'en' ? (
            <div style={{ marginTop: 12, fontSize: fonts.scaled(11), color: palette.textMuted, fontStyle: 'italic' }}>
              {DISCLAIMER_EN_NOTICE}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 14,
            background: palette.primary,
            color: palette.primaryContrast,
            border: 'none',
            borderRadius: 10,
            padding: '11px 14px',
            fontWeight: 800,
            fontSize: fonts.scaled(13),
            cursor: 'pointer',
          }}
        >
          {acceptLabel || t('onboarding.disclaimer.accept')}
        </button>
      </div>
    </div>
  );
}