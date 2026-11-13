// 对话内搜索（桌面）：输入框 + 命中计数 + 上/下条跳转 + 关闭。
//
// 逻辑全部复用共享层 chat/chatSearchMath.js（collectSearchMatchIds / advanceMatchIndex）：
// 命中判定、循环推进、关闭时短路不扫全历史，三条口径与手机完全一致，不在这里重写。
// 桌面只补两件手机上不需要的事：
//   · 命中消息的 DOM 滚动与高亮（手机走 FlatList 的 scrollToIndex）；
//   · 输入框用受控 input + Enter/Shift+Enter 上下条（手机是键盘 returnKey）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function ChatSearchBar({
  open,
  query,
  onChangeQuery,
  matchCount,
  activeMatchIndex,
  onPrev,
  onNext,
  onClose,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const navButton = (label, title, onClick, disabled) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        background: 'transparent',
        color: disabled ? palette.textFaint : palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 6,
        width: 26,
        height: 26,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 12,
        lineHeight: 1,
        flex: 'none',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      background: palette.surfaceAlt,
      flex: 'none',
    }}
    >
      <span style={{ fontSize: 14, color: palette.textFaint, lineHeight: 1 }}>🔍</span>
      <input
        value={query}
        onChange={event => onChangeQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrev();
            else onNext();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t('chat.search.placeholder')}
        autoFocus
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          background: palette.surface,
          color: palette.text,
          border: `1px solid ${palette.divider}`,
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: fonts.scaled(13),
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      {/* 与手机同一口径：0/0 表示无命中（不是 1/0）。 */}
      <span style={{
        fontSize: fonts.scaled(11),
        color: palette.textMuted,
        minWidth: 46,
        textAlign: 'right',
        flex: 'none',
        fontVariantNumeric: 'tabular-nums',
      }}
      >
        {matchCount ? `${activeMatchIndex + 1}/${matchCount}` : '0/0'}
      </span>
      {navButton('‹', t('chat.search.prevA11y'), onPrev, matchCount === 0)}
      {navButton('›', t('chat.search.nextA11y'), onNext, matchCount === 0)}
      <button
        type="button"
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
        style={{
          background: 'transparent',
          color: palette.textMuted,
          border: 'none',
          cursor: 'pointer',
          fontSize: 15,
          lineHeight: 1,
          flex: 'none',
          padding: '2px 4px',
        }}
      >
        ×
      </button>
    </div>
  );
}