// 角色 / 群聊切换（桌面）：对应手机 chat/SwitcherModal。
//
// 手机在聊天页顶栏点头像打开它；桌面上顶栏是五个标签 + 「+」，所以在聊天面板的群聊
// 头部与「更多」菜单里各给一个入口（单聊没有群聊头部，走菜单）。
//
// 只负责「列出并切换」：切换动作交给宿主（switchCharacter / switchSession），
// 与手机 onSwitch / onSwitchGroup 的分工一致——不在界面里自己动会话状态。
import { useMemo } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function SwitcherPanel({
  open,
  onClose,
  characters,
  activeId,
  onSwitchCharacter,
  groupSessions,
  activeSessionId,
  onSwitchGroup,
  groupNameOf,
  palette,
  fonts,
}) {
  const { t } = useTranslation();

  const groups = useMemo(() => (Array.isArray(groupSessions) ? groupSessions : []), [groupSessions]);
  if (!open) return null;

  const row = (key, label, sub, active, onClick) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: active ? palette.surfaceAlt : 'transparent',
        color: palette.text,
        border: `1px solid ${active ? palette.primaryMuted : palette.divider}`,
        borderRadius: 8,
        padding: '7px 10px',
        cursor: 'pointer',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: fonts.scaled(12), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {sub ? (
        <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint, flex: 'none' }}>{sub}</span>
      ) : null}
      {active ? (
        <span style={{ fontSize: fonts.scaled(10), color: palette.primaryMuted || palette.primary, flex: 'none' }}>
          {t('chat.switcher.current')}
        </span>
      ) : null}
    </button>
  );

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(460px, 94vw)',
          maxHeight: '82vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 16,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(14) }}>{t('chat.switcher.title')}</strong>
          <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(Array.isArray(characters) ? characters : []).map(character => row(
            character.id,
            character.name || t('common.unnamedCharacter'),
            '',
            character.id === activeId,
            () => { onSwitchCharacter(character.id); onClose(); }
          ))}
        </div>
        {groups.length > 0 ? (
          <>
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, marginTop: 4 }}>
              {t('common.groupChat')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {groups.map(session => row(
                session.id,
                groupNameOf(session),
                '',
                session.id === activeSessionId,
                () => { onSwitchGroup(session.id); onClose(); }
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
