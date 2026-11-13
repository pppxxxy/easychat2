// 后台运行提示条（桌面）：当前会话在生成，而用户已经切到别处时，把这件事显示出来。
//
// 与手机 RunningRunsBar 同一定位（「别让后台运行静默消失」），但数据源不同：
// 手机读应用级登记表 agent/runtime/sessionRuns（那是 Agent 运行时域的骨架）；
// 桌面单窗口、同一时刻只有一条前台运行，直接由宿主传入「是否在跑 + 是哪一段会话」即可，
// 不需要为它引入一套全局登记表。
//
// 存在的理由：useChatSend 的回复在用户切走后走 persistBackgroundReply 写回它自己的
// 会话（不丢），但界面上完全看不到发生了什么——用户会以为消息没了。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function RunningNoticeBar({
  visible,
  sessionName,
  onOpen,
  onStop,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '5px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      background: palette.surfaceAlt,
      flex: 'none',
    }}
    >
      <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
        {t('chat.running.title')}
        {' · '}
        {sessionName || t('chat.running.unknown')}
      </span>
      <span style={{ flex: 1 }} />
      <Button
        label={t('chat.running.a11y.open', { name: sessionName || t('chat.running.unknown') })}
        onClick={onOpen}
        palette={palette}
        fonts={fonts}
      />
      <Button
        label={t('chat.running.stop')}
        onClick={onStop}
        palette={palette}
        fonts={fonts}
        tone={palette.danger || '#ff5a5f'}
      />
    </div>
  );
}
