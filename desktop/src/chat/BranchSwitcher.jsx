// 分支版本切换器（桌面）：助手气泡下方的 `< N / M >`。
//
// 与 Android BranchSwitcher 同一版式与语义：版本按时间旧→新编号，当前版本显示序号，
// 首/末版本对应箭头置灰，单版本不渲染。点击前后箭头切换分支（切走时把当前尾段归档）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function BranchSwitcher({ nav, onPrev, onNext, disabled, palette, fonts }) {
  const { t } = useTranslation();
  if (!nav || !(Number(nav.total) > 1)) return null;
  const prevDisabled = !!disabled || !nav.prevId;
  const nextDisabled = !!disabled || !nav.nextId;
  const arrow = (label, handler, isDisabled) => (
    <button
      type="button"
      onClick={isDisabled ? undefined : handler}
      disabled={isDisabled}
      title={label}
      aria-label={label}
      style={{
        background: 'transparent',
        border: 'none',
        color: isDisabled ? palette.textFaint : palette.textMuted,
        cursor: isDisabled ? 'default' : 'pointer',
        fontSize: fonts.scaled(12),
        padding: '0 4px',
        lineHeight: 1,
      }}
    >
      {label === t('chat.branch.prevA11y') ? '‹' : '›'}
    </button>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 2, userSelect: 'none' }}>
      {arrow(t('chat.branch.prevA11y'), onPrev, prevDisabled)}
      <span style={{ fontSize: fonts.scaled(11), color: palette.textFaint, fontVariantNumeric: 'tabular-nums' }}>
        {`${nav.index}///${nav.total}`}
      </span>
      {arrow(t('chat.branch.nextA11y'), onNext, nextDisabled)}
    </div>
  );
}