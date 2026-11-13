// 群聊头部条（桌面）：群名 + 成员数 + 缺失成员提示 + @提及 / 群设置入口。
//
// 从 provider/ChatPane.jsx 外提（那里撞到 800 行棘轮）。纯展示组件：
// 群名、成员、缺失 id 都由宿主算好传入；两个按钮只触发回调。
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function GroupHeaderBar({
  groupName,
  memberCount,
  missingCount,
  mentionOpen,
  onToggleMention,
  onOpenSettings,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const pill = (active, label, onClick, title) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      title={title || label}
      style={{
        background: active ? palette.surface : 'transparent',
        color: palette.textMuted,
        border: `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '3px 10px',
        cursor: 'pointer',
        fontSize: fonts.scaled(11),
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
      gap: 10,
      padding: '8px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      flex: 'none',
      background: palette.surfaceAlt,
    }}
    >
      <strong style={{ fontSize: fonts.scaled(13) }}>{groupName}</strong>
      <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
        {t('character.library.scrubber.groupMeta', { count: memberCount })}
      </span>
      {missingCount > 0 ? (
        <span style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
          {t('group.members.missing', { count: missingCount })}
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      {pill(mentionOpen, '@', onToggleMention, t('chat.mention.title'))}
      {pill(false, t('group.settings.title'), onOpenSettings)}
    </div>
  );
}
