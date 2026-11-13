// 群聊 @ 提及面板（桌面）：点选成员或「@全体」把提及插入输入框。
//
// 解析与语义全在共享层 chat/groupMentions.js：
//   · parseMentions —— 发送时 useChatSend 调用它把 @名字 映射成 characters.id；
//   · hasEveryoneMention —— @全体 会让调度器把所有成员都排上。
// 桌面只需一个「点谁 → 往光标处插 @名字 」。手机上这个面板在「输入 @ 时自动弹」，
// 桌面用按钮触发（没有软键盘，光标自动弹出会挡视线）。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button, Card } from '../settings/ui.jsx';

export default function MentionPicker({
  open,
  members,
  palette,
  fonts,
  onPick,
  onClose,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const row = (key, label, onClick) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: 'transparent',
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: fonts.scaled(12),
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <Card title={t('chat.mention.title')} palette={palette} fonts={fonts}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {/* 「@全体」排第一（与手机 MentionPickerModal 一致）。 */}
        {row('everyone', `@${t('chat.mention.everyone')}`, () => onPick(t('chat.mention.everyone')))}
        {(Array.isArray(members) ? members : []).map(member => {
          const name = String((member && member.name) || '').trim() || t('chat.mention.unnamed');
          return row(member.id || name, `@${name}`, () => onPick(name));
        })}
      </div>
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
        {t('chat.mention.hint')}
      </div>
      <div>
        <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
      </div>
    </Card>
  );
}