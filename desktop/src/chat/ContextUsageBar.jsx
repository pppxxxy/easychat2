// 上下文占用条（桌面聊天页顶部）：占用百分比 + token 计数 + 「压缩」入口。
//
// 显示口径来自 chat/usageView（与 Android 同源阈值）：
//   normal  —— 占用条细、低调色；
//   high    —— 过「建议压缩」线，条转警示色并出现「压缩」按钮；
//   critical——到自动压缩线，条转危险色并提示「下一次请求可能超限」。
// 用户可关掉这一次的提示；关掉只影响本次进入会话（切会话/重载恢复），与 Android 一致。
import { useMemo } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  formatTokenCount,
  shouldShowCompactHint,
  usageLevel,
  usagePercent,
  usageThresholds,
} from './usageView.js';

export default function ContextUsageBar({
  usage,
  dismissed,
  meaningfulMessages,
  onDismiss,
  onCompact,
  compactBusy,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const thresholds = useMemo(() => usageThresholds(usage), [usage]);
  const level = usageLevel(usage, thresholds);
  const percent = usagePercent(usage);
  // 窗口未知（没有配置/没有消息）时不显示占用条——显示 0% 只会误导。
  if (!(usage && usage.window > 0) || usage.tokens <= 0) return null;

  const color = level === 'critical'
    ? (palette.danger || '#ff5a5f')
    : level === 'high' ? (palette.warning || palette.primary) : palette.primary;
  // 是否出现「压缩」入口：与阈值同源判定（过提示线 + 未忽略 + 确有内容可压）。
  const showAction = shouldShowCompactHint(usage, thresholds, { dismissed, meaningfulMessages });

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      background: level === 'critical' ? palette.surfaceAlt : 'transparent',
      flex: 'none',
    }}
    >
      <div style={{ flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fonts.scaled(11), color: palette.textMuted }}>
          <span>{t('workspace.panel.context.label')}</span>
          <span style={{ color }}>
            {t('workspace.panel.context.usage', {
              tokens: formatTokenCount(usage.tokens),
              window: formatTokenCount(usage.window),
              percent,
            })}
          </span>
          {level === 'critical' ? (
            <span style={{ color: palette.danger || '#ff5a5f' }}>{t('chat.compact.hint', { percent })}</span>
          ) : null}
        </div>
        <div style={{ height: 4, borderRadius: 2, background: palette.divider, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, Math.max(0, percent))}%`,
            height: '100%',
            background: color,
            transition: 'width 160ms ease-out',
          }}
          />
        </div>
      </div>
      {showAction ? (
        <>
          <button
            type="button"
            onClick={() => onCompact()}
            disabled={compactBusy}
            style={{
              background: color,
              color: palette.primaryContrast,
              border: 'none',
              borderRadius: 8,
              padding: '5px 12px',
              fontSize: fonts.scaled(11),
              fontWeight: 700,
              cursor: compactBusy ? 'default' : 'pointer',
              flex: 'none',
            }}
          >
            {compactBusy ? t('chat.settings.compactBusy') : t('chat.compact.action')}
          </button>
          {level === 'high' ? (
            <button
              type="button"
              onClick={onDismiss}
              style={{
                background: 'transparent',
                color: palette.textFaint,
                border: 'none',
                fontSize: fonts.scaled(11),
                cursor: 'pointer',
                padding: 0,
                flex: 'none',
              }}
            >
              {t('chat.compact.dismiss')}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}