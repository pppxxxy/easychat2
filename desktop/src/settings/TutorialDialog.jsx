// 桌面教程弹层：章节逐步浏览（与 Android OnboardingModal 同一内容源）。
//
// 内容取 getOnboardingChapters(undefined, localeId)：中英由界面语言决定，章节内
// 的图标名（Ionicons）在桌面上没有字形，改用序号徽标替代（不引入图标字体依赖）。
import { useEffect, useState } from 'react';

import { getOnboardingChapters } from '../../../src/onboarding/onboardingContent.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function TutorialDialog({ open, onClose, palette, fonts, finishLabel }) {
  const { t, localeId } = useTranslation();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  if (!open) return null;
  const chapters = getOnboardingChapters(undefined, localeId);
  const total = chapters.length;
  if (total === 0) return null;
  const safeIndex = Math.min(index, total - 1);
  const chapter = chapters[safeIndex];
  const isFirst = safeIndex <= 0;
  const isLast = safeIndex >= total - 1;

  const button = (label, onClick, { primary = false, disabled = false } = {}) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: primary ? palette.primary : 'transparent',
        color: primary ? palette.primaryContrast : palette.textMuted,
        border: primary ? 'none' : `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '8px 14px',
        fontSize: fonts.scaled(12),
        fontWeight: primary ? 700 : 500,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 58,
        background: 'rgba(0,0,0,0.68)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        width: 'min(760px, 94vw)',
        height: '82vh',
        display: 'flex',
        flexDirection: 'column',
        background: palette.background,
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        overflow: 'hidden',
        color: palette.text,
      }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 18px',
          borderBottom: `1px solid ${palette.divider}`,
        }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: fonts.scaled(12), color: palette.textMuted, fontWeight: 600 }}>
              {t('onboarding.progress', { index: safeIndex + 1, total })}
            </span>
            <div style={{ height: 4, borderRadius: 999, background: palette.surfaceAlt, overflow: 'hidden' }}>
              <div style={{
                height: 4,
                width: `${((safeIndex + 1) / total) * 100}%`,
                background: palette.primary,
                borderRadius: 999,
              }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('onboarding.skipA11y')}
            style={{
              background: 'transparent',
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              color: palette.textMuted,
              padding: '5px 10px',
              fontSize: fonts.scaled(12),
              cursor: 'pointer',
            }}
          >
            {t('onboarding.skip')}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 18, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: palette.primary,
              color: palette.primaryContrast,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: fonts.scaled(13),
              fontWeight: 800,
              flex: 'none',
            }}
            >
              {safeIndex + 1}
            </span>
            <strong style={{ fontSize: fonts.scaled(17) }}>{chapter.title}</strong>
          </div>

          {chapter.summary ? (
            <div style={{ fontSize: fonts.scaled(13), color: palette.primaryMuted, fontWeight: 700, marginBottom: 8 }}>
              {chapter.summary}
            </div>
          ) : null}
          {chapter.intro ? (
            <div style={{ fontSize: fonts.scaled(13), lineHeight: 1.75, color: palette.textMuted, marginBottom: 12 }}>
              {chapter.intro}
            </div>
          ) : null}

          {(chapter.sections || []).map((section, sectionIndex) => (
            <div key={section.title || sectionIndex} style={{ marginBottom: 12 }}>
              {section.title ? (
                <div style={{ fontSize: fonts.scaled(12), fontWeight: 800, color: palette.text, marginBottom: 4 }}>
                  {section.title}
                </div>
              ) : null}
              {section.body ? (
                <div style={{ fontSize: fonts.scaled(12), lineHeight: 1.7, color: palette.textMuted }}>{section.body}</div>
              ) : null}
              {(section.bullets || []).map((bullet, bulletIndex) => (
                <div key={bulletIndex} style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <span style={{ color: palette.primaryMuted }}>•</span>
                  <span style={{ fontSize: fonts.scaled(12), lineHeight: 1.7, color: palette.textMuted }}>{bullet}</span>
                </div>
              ))}
            </div>
          ))}

          {(chapter.items || []).length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {chapter.items.map((item, itemIndex) => (
                <div
                  key={itemIndex}
                  style={{
                    border: `1px solid ${palette.divider}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{item.name}</span>
                  {item.where ? (
                    <span style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{item.where}</span>
                  ) : null}
                  {item.usage ? (
                    <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{item.usage}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {(chapter.steps || []).map((step, stepIndex) => (
            <div key={stepIndex} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <span style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                background: palette.surfaceAlt,
                color: palette.primaryMuted,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: fonts.scaled(11),
                fontWeight: 800,
                flex: 'none',
              }}
              >
                {stepIndex + 1}
              </span>
              <span style={{ fontSize: fonts.scaled(13), lineHeight: 1.7, color: palette.text }}>{step}</span>
            </div>
          ))}

          {chapter.note ? (
            <div style={{
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: fonts.scaled(11),
              lineHeight: 1.7,
              color: palette.textFaint,
              marginTop: 4,
            }}
            >
              {chapter.note}
            </div>
          ) : null}

          {chapter.outro && chapter.outro.text ? (
            <div style={{ marginTop: 12, fontSize: fonts.scaled(12), lineHeight: 1.7, color: palette.textMuted }}>
              {chapter.outro.text}
            </div>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center', marginTop: 18 }}>
            {chapters.map((item, dotIndex) => (
              <span
                key={item.id}
                style={{
                  width: dotIndex === safeIndex ? 16 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: dotIndex === safeIndex ? palette.primary : palette.surfaceBorder,
                }}
              />
            ))}
          </div>
        </div>

        <div style={{
          display: 'flex',
          gap: 8,
          padding: '12px 18px',
          borderTop: `1px solid ${palette.divider}`,
        }}
        >
          <div style={{ flex: 1 }}>{button(t('onboarding.prev'), () => setIndex(current => Math.max(current - 1, 0)), { disabled: isFirst })}</div>
          <div style={{ flex: 1.3 }}>
            {button(
              isLast ? (finishLabel || t('onboarding.start')) : t('onboarding.next'),
              () => (isLast ? onClose() : setIndex(current => Math.min(current + 1, total - 1))),
              { primary: true }
            )}
          </div>
        </div>
      </div>
    </div>
  );
}