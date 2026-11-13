// 消息定位条（桌面）界面：一条竖直滑轨 + 拖动时的预览。
//
// 手机上是全屏 Modal + PanResponder；桌面用「右侧浮出的窄条 + input[type=range]」——
// 鼠标拖动与键盘（方向键）都能用，且不需要自定义手势识别。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function ScrollScrubber({
  open,
  onClose,
  count,
  previews,
  onSeek,
  onToStart,
  onToEnd,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const handleChange = event => {
    // range 的 value 是 0..1000（整数百分比），换算成消息下标。
    const ratio = Number(event.target.value) / 1000;
    onSeek(Math.round(ratio * Math.max(0, count - 1)));
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: 220,
      zIndex: 48,
      background: palette.surface,
      borderLeft: `1px solid ${palette.divider}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 12,
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: fonts.scaled(12) }}>{t('chat.menu.scrubber')}</strong>
        <button
          type="button"
          onClick={onClose}
          title={t('chat.scrubber.closeA11y')}
          aria-label={t('chat.scrubber.closeA11y')}
          style={{ background: 'transparent', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: 15 }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
        {t('chat.menu.scrubber') + ' · ' + String(count)}
      </div>
      {/* 滑轨：竖直方向用 CSS 旋转 range 实现，鼠标与键盘都能操作。 */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
        <input
          type="range"
          min="0"
          max="1000"
          defaultValue="1000"
          onChange={handleChange}
          aria-label={t('chat.scrubber.trackA11y')}
          style={{
            width: '80%',
            transform: 'rotate(-90deg)',
            accentColor: palette.primary,
            cursor: 'pointer',
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Button label={t('chat.scrubber.toStart')} onClick={onToStart} palette={palette} fonts={fonts} />
        <Button label={t('chat.scrubber.toEnd')} onClick={onToEnd} palette={palette} fonts={fonts} />
      </div>
      {previews.length > 0 ? (
        // 拖动时显示当前命中条的预览（说话人 + 前 60 字），与手机同口径。
        <div style={{
          fontSize: fonts.scaled(10),
          color: palette.textFaint,
          lineHeight: 1.5,
          minHeight: 34,
          overflow: 'hidden',
        }}
        >
          {String(previews[Math.max(0, previews.length - 1)].speaker || '')}
          {' · '}
          {String(previews[Math.max(0, previews.length - 1)].text || '')}
        </div>
      ) : null}
    </div>
  );
}