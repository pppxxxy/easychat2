// 后台运行提示条（桌面）：列出**正在生成**的会话，可停止或切过去。
//
// 与手机 RunningRunsBar 同一数据源、同一语义：sessionRuns 是应用级登记表
// （agent/runtime/sessionRuns，纯模块、只依赖 commandQueue），发送路径在
// useSessionGuard.beginSendOperation 里登记，切走会话时 invalidateSessionOperations
// **不中止**运行——回复走 persistBackgroundReply 写回它自己的会话。
//
// 所以「非当前会话正在跑」在桌面是真实可达的状态，而桌面此前只显示当前会话的
// 「生成中」提示：切走之后后台那段在界面上完全消失，用户会以为消息丢了。
// 这里如实列出来，并给「停止」「切过去」两个动作（与手机一致）。
//
// 当前会话的运行不在这里重复显示——它由输入区的「停止」按钮体现（同手机口径）。
import { useEffect, useState } from 'react';

import { sessionRuns } from '../../../src/agent/runtime/sessionRuns.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function RunningNoticeBar({
  activeSessionId,
  sessionLabelOf,
  onOpen,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  // 订阅登记表：运行开始/结束都会推一份最新快照。
  const [runs, setRuns] = useState(() => sessionRuns.list());
  useEffect(() => sessionRuns.subscribe(snapshot => setRuns(snapshot)), []);

  // 只显示**非当前会话**的运行（当前会话由输入区体现）。
  const background = runs.filter(run => String(run.sessionId || '') !== String(activeSessionId || ''));
  if (background.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '6px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      background: palette.surfaceAlt,
      flex: 'none',
    }}
    >
      <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
        {t('chat.running.title')}
        {' · '}
        {background.length}
      </div>
      {background.map(run => {
        const label = sessionLabelOf(run) || t('chat.running.unknown');
        return (
          <div
            key={run.sessionId}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span style={{
              flex: 1,
              minWidth: 0,
              fontSize: fonts.scaled(11),
              color: palette.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            >
              {label}
            </span>
            {/* 「切过去」：与手机的 a11y 文案同义（切到那个会话看进度）。 */}
            <Button
              label={t('chat.running.a11y.open', { name: label })}
              onClick={() => onOpen(run.sessionId)}
              palette={palette}
              fonts={fonts}
            />
            <Button
              label={t('chat.running.stop')}
              onClick={() => sessionRuns.cancel(run.sessionId)}
              palette={palette}
              fonts={fonts}
              tone={palette.danger || '#ff5a5f'}
            />
          </div>
        );
      })}
    </div>
  );
}
