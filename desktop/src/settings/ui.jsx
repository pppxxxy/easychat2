// 桌面设置页的通用控件（纯展示，无业务逻辑）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export function Card({ title, hint, children, palette, fonts, tone }) {
  return (
    <section style={{
      border: `1px solid ${tone || palette.divider}`,
      borderRadius: 12,
      padding: 16,
      marginBottom: 14,
      background: palette.surface,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, justifyContent: 'space-between' }}>
        <strong style={{ fontSize: fonts.scaled(14), color: palette.text }}>{title}</strong>
      </div>
      {hint ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>{hint}</div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, palette, fonts }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  palette,
  fonts,
  type = 'text',
  disabled = false,
  maxLength = undefined,
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      // 名称类字段在存储层有上限（如 SHELF_NAME_MAX=40）：输入框先拦住，
      // 否则超长名一路走到保存才被拒，用户得重新想名字。
      maxLength={maxLength}
      onChange={event => onChange(event.target.value)}
      spellCheck={false}
      autoComplete="off"
      style={{
        background: palette.surfaceAlt,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: fonts.scaled(13),
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
        opacity: disabled ? 0.6 : 1,
      }}
    />
  );
}

export function SecretInput({ value, onChange, placeholder, palette, fonts }) {
  const { t } = useTranslation();
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        palette={palette}
        fonts={fonts}
        type="password"
      />
      <span
        title={t('settings.secret.show')}
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11,
          color: palette.textFaint,
          pointerEvents: 'none',
        }}
      >
        ●
      </span>
    </div>
  );
}

export function Select({ value, options, onChange, palette, fonts, disabled = false }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      style={{
        background: palette.surfaceAlt,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: fonts.scaled(13),
        outline: 'none',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, palette, fonts, disabled = false }) {
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: disabled ? 'default' : 'pointer',
      fontSize: fonts.scaled(12),
      color: palette.text,
      opacity: disabled ? 0.6 : 1,
    }}
    >
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Button({ label, onClick, palette, fonts, primary = false, disabled = false, tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: primary ? palette.primary : 'transparent',
        color: primary ? palette.primaryContrast : (tone || palette.textMuted),
        border: primary ? 'none' : `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '7px 14px',
        fontSize: fonts.scaled(12),
        fontWeight: primary ? 700 : 500,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

export function Row({ children, gap = 8 }) {
  return <div style={{ display: 'flex', gap, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>;
}

export function Divider({ palette }) {
  return <div style={{ height: 1, background: palette.divider, margin: '4px 0' }} />;
}