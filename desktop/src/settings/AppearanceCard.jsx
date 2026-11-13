// 外观卡：主题（内置 + 自定义配色只读展示）、字号、界面语言。
// 主题/字号写入经 ThemeContext（内部走 patchAppearanceSettings，不会重置语言）；
// 语言走 I18nContext。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { useTheme } from '../../../src/theme/ThemeContext.js';
import { Card, Field, Row, Select } from './ui.jsx';

export default function AppearanceCard({ palette, fonts }) {
  const { t, localeId, setLocaleId } = useTranslation();
  const {
    themes,
    themeId,
    setThemeId,
    fontScales,
    fontScaleId,
    setFontScaleId,
  } = useTheme();

  return (
    <Card title={t('settings.appearance.title')} palette={palette} fonts={fonts}>
      <Field label={t('settings.appearance.theme')} palette={palette} fonts={fonts}>
        <Select
          value={themeId}
          options={themes.map(theme => ({ value: theme.id, label: t(theme.labelKey) }))}
          onChange={setThemeId}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Row>
        <Field label={t('settings.appearance.fontScale')} palette={palette} fonts={fonts}>
          <Select
            value={fontScaleId}
            options={fontScales.map(option => ({ value: option.id, label: t(option.labelKey) }))}
            onChange={setFontScaleId}
            palette={palette}
            fonts={fonts}
          />
        </Field>
        <Field label={t('settings.language.title')} hint={t('settings.language.hint')} palette={palette} fonts={fonts}>
          <Select
            value={localeId}
            options={[
              { value: 'zh-CN', label: t('settings.language.zh') },
              { value: 'en', label: t('settings.language.en') },
            ]}
            onChange={setLocaleId}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      </Row>
      <div style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        marginTop: 2,
      }}
      >
        {themes.map(theme => (
          <span
            key={theme.id}
            title={t('settings.appearance.switchTheme', { name: t(theme.labelKey) })}
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              background: theme.colors.primary,
              border: `2px solid ${theme.id === themeId ? palette.text : 'transparent'}`,
              boxShadow: `inset 0 0 0 2px ${theme.colors.background}`,
            }}
          />
        ))}
      </div>
    </Card>
  );
}