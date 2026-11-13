// 会话列表面板（桌面「记忆」页）：切换 / 重命名 / 置顶 / 克隆 / 删除。
//
// 从 provider/DesktopApp.jsx 外提：那里已逼近 800 行棘轮，且会话操作与聊天页是
// 两个关注点。存储复用共享层 sessionList（updateSessionInfo / cloneSession 等），
// 列表状态来自 AppContext（switchSession/deleteSession/pinSession/cloneSession）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { updateSessionInfo } from '../../../src/storage/sessionList.js';

export default function SessionsPanel({
  palette,
  fonts,
  character,
  sessions,
  activeSessionId,
  busy,
  onSwitch,
  onDelete,
  onPin,
  onClone,
  onRenameDone,
}) {
  const { t } = useTranslation();

  const ghost = {
    background: 'transparent',
    color: palette.textMuted,
    border: `1px solid ${palette.divider}`,
    borderRadius: 8,
    padding: '2px 8px',
    cursor: busy ? 'default' : 'pointer',
    fontSize: 12,
  };

  const rename = session => {
    const next = window.prompt(t('chat.session.renameTitle'), session.title || '');
    if (next === null) return;
    const title = String(next).trim();
    if (!title) return;
    Promise.resolve(updateSessionInfo(session.id, { title }))
      .then(() => onRenameDone?.())
      .catch(() => {});
  };

  return (
    <section style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12), marginBottom: 10 }}>
        {character ? character.name : '—'} · {t('app.tab.sessions')} ({sessions.length})
      </div>
      {sessions.map(session => (
        <div
          key={session.id}
          role="button"
          tabIndex={0}
          onClick={() => onSwitch(session.id)}
          onKeyDown={event => { if (event.key === 'Enter') onSwitch(session.id); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 10,
            cursor: 'pointer',
            background: session.id === activeSessionId ? palette.surfaceAlt : palette.surface,
            border: `1px solid ${session.id === activeSessionId ? palette.primaryMuted : palette.divider}`,
            marginBottom: 6,
            justifyContent: 'space-between',
          }}
        >
          <span style={{
            fontSize: fonts.scaled(13),
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          >
            {session.pinned ? '📌 ' : ''}{session.title || session.id.slice(0, 12)}
          </span>
          <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
            <button
              type="button"
              style={ghost}
              disabled={!!busy}
              title={t('chat.session.rename')}
              onClick={event => {
                event.stopPropagation();
                rename(session);
              }}
            >
              ✎
            </button>
            <button
              type="button"
              style={ghost}
              disabled={!!busy}
              title={session.pinned ? t('chat.session.unpin') : t('chat.session.pin')}
              onClick={event => {
                event.stopPropagation();
                onPin(session.id);
              }}
            >
              {session.pinned ? '📌' : '📍'}
            </button>
            <button
              type="button"
              style={ghost}
              disabled={!!busy}
              title={t('chat.session.clone')}
              onClick={event => {
                event.stopPropagation();
                onClone(session.id);
              }}
            >
              ⧉
            </button>
            <button
              type="button"
              style={ghost}
              disabled={!!busy}
              title={t('chat.session.delete')}
              onClick={event => {
                event.stopPropagation();
                onDelete(session.id);
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}