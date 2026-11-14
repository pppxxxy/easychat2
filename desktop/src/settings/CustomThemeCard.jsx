// 自定义配色（桌面）：对应手机 settings/CustomThemeModal.js。
//
// 全部判定复用共享 theme/themes.js——这里**不重写**任何一条：
//   · CUSTOM_COLOR_GROUPS / CUSTOM_COLOR_FIELDS  决定改哪些槽位、如何分组；
//   · CUSTOM_COLOR_FIELD_KEYS                    槽位名 → i18n key（不硬编码中文）；
//   · CUSTOM_COLOR_PRESETS                       预置色板；
//   · resolveCustomColors                        未改动槽位的初值（自定义主题底稿 + 用户覆盖）；
//   · isValidHexColor / normalizeCustomColors    校验与归一化。
// 保存走 ThemeContext.setCustomColors（内部会 normalize 并把主题切到 custom），
// 所以「保存并应用」的语义与手机一致，不在这里另存一份。
//
// 手机那版是 Modal + 色轮/十六进制输入；桌面用原生 <input type="color"> + 十六进制文本框，
// 这是平台差异，不是能力缺失——Chromium 自带取色器。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { useTheme } from '../../../src/theme/ThemeContext.js';
import {
  CUSTOM_COLOR_FIELD_KEYS,
  CUSTOM_COLOR_FIELDS,
  CUSTOM_COLOR_GROUPS,
  CUSTOM_COLOR_PRESETS,
  isValidHexColor,
  resolveCustomColors,
} from '../../../src/theme/themes.js';
import { Button, Card } from './ui.jsx';

export default function CustomThemeCard({ palette, fonts }) {
  const { t } = useTranslation();
  const { customColors, setCustomColors } = useTheme();
  // 编辑器初值：未改动过的槽位显示自定义主题底稿里的颜色（否则一片空白，
  // 用户看不出「不改会是什么样」）。
  const [draft, setDraft] = useState(() => resolveCustomColors(customColors));

  const dirty = useMemo(() => {
    const base = resolveCustomColors(customColors);
    return CUSTOM_COLOR_FIELDS.some(field => String(draft[field] || '') !== String(base[field] || ''));
  }, [customColors, draft]);

  const setField = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
  };

  const reset = () => setDraft(resolveCustomColors(customColors));

  return (
    <Card
      title={t('theme.custom.title')}
      hint={t('theme.custom.hint')}
      palette={palette}
      fonts={fonts}
    >
      {CUSTOM_COLOR_GROUPS.map(group => (
        <div key={group.id} style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: fonts.scaled(11),
            fontWeight: 700,
            color: palette.textMuted,
            marginBottom: 6,
          }}
          >
            {t(group.labelKey)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {group.fields.map(field => {
              const value = String(draft[field] || '');
              const valid = isValidHexColor(value);
              return (
                <div key={field} style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 132 }}>
                  <label
                    htmlFor={`custom-color-${field}`}
                    style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}
                  >
                    {CUSTOM_COLOR_FIELD_KEYS[field] ? t(CUSTOM_COLOR_FIELD_KEYS[field]) : field}
                  </label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      id={`custom-color-${field}`}
                      type="color"
                      value={valid ? value : '#000000'}
                      onChange={event => setField(field, event.target.value)}
                      style={{
                        width: 28,
                        height: 24,
                        padding: 0,
                        border: `1px solid ${palette.divider}`,
                        borderRadius: 6,
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    />
                    <input
                      type="text"
                      value={value}
                      spellCheck={false}
                      onChange={event => setField(field, event.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: palette.surface,
                        color: valid ? palette.text : palette.danger,
                        border: `1px solid ${valid ? palette.divider : palette.danger}`,
                        borderRadius: 6,
                        padding: '3px 6px',
                        fontSize: fonts.scaled(10),
                        fontFamily: 'monospace',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, marginBottom: 6 }}>
          {t('theme.custom.preview.title')}
        </div>
        {/* 预览区：与手机同结构（背景/角色气泡/我的气泡/按钮/次要文字）。
            用 draft 里的色值直接渲染，所以改一个槽位立刻能看到效果。 */}
        <div style={{
          background: draft.background,
          border: `1px solid ${draft.surfaceBorder}`,
          borderRadius: 10,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
        >
          <div style={{
            alignSelf: 'flex-start',
            background: draft.bubbleAssistant,
            color: draft.bubbleAssistantText,
            borderRadius: 8,
            padding: '5px 9px',
            fontSize: fonts.scaled(11),
            maxWidth: '85%',
          }}
          >
            {t('theme.custom.preview.assistant')}
          </div>
          <div style={{
            alignSelf: 'flex-end',
            background: draft.primary,
            color: draft.primaryContrast,
            borderRadius: 8,
            padding: '5px 9px',
            fontSize: fonts.scaled(11),
            maxWidth: '85%',
          }}
          >
            {t('theme.custom.preview.user')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
            <span style={{
              background: draft.primary,
              color: draft.primaryContrast,
              borderRadius: 6,
              padding: '3px 10px',
              fontSize: fonts.scaled(10),
            }}
            >
              {t('theme.custom.preview.button')}
            </span>
            <span style={{ color: draft.textMuted, fontSize: fonts.scaled(10) }}>
              {t('theme.custom.preview.muted')}
            </span>
            <span style={{ color: draft.textFaint, fontSize: fonts.scaled(10) }}>
              {t('theme.custom.preview.faint')}
            </span>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, marginBottom: 6 }}>
          {t('desktop.theme.presets')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {CUSTOM_COLOR_PRESETS.map(color => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={color}
              onClick={() => {
                // 预置色点一下就填到「当前聚焦的槽位」是不可行的（没有焦点概念），
                // 所以预置色只作为取色参考：点击复制到剪贴板由用户自行粘贴。
                // 更实用的是直接把它作为 primary——但那是猜测意图。
                // 这里改为：点击把色值写进浏览器剪贴板，并在 title 里已显示色值。
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(color).catch(() => {});
                }
              }}
              style={{
                width: 22,
                height: 22,
                padding: 0,
                borderRadius: 5,
                border: `1px solid ${palette.divider}`,
                background: color,
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          label={t('theme.custom.save')}
          onClick={() => setCustomColors(draft)}
          palette={palette}
          fonts={fonts}
          disabled={!dirty}
        />
        <Button
          label={t('theme.custom.reset')}
          onClick={reset}
          palette={palette}
          fonts={fonts}
          disabled={!dirty}
        />
      </div>
    </Card>
  );
}
