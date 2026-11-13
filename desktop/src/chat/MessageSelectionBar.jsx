// 多选工具条（桌面）：选中态下显示「取消 / 已选 N / 全选 / 删除」。
//
// 从 provider/ChatPane.jsx 外提（那里撞到 800 行棘轮）：这一段是纯展示，
// 所有状态与动作都由 useMessageSelection 提供，拆出来后 ChatPane 只留一行挂载。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function MessageSelectionBar({
  selection,
  isSending,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!selection || !selection.selecting) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 20px',
      borderBottom: `1px solid ${palette.divider}`,
      background: palette.surfaceAlt,
      flex: 'none',
    }}
    >
      <Button
        label={t('chat.topBar.selection.cancel')}
        onClick={selection.cancel}
        palette={palette}
        fonts={fonts}
      />
      <span style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
        {t('chat.topBar.selection.count', { count: selection.selectedCount })}
      </span>
      <Button
        label={selection.allSelected
          ? t('chat.topBar.selection.unselectAll')
          : t('chat.topBar.selection.selectAll')}
        onClick={selection.toggleAll}
        palette={palette}
        fonts={fonts}
        disabled={selection.allIds.length === 0}
      />
      <span style={{ flex: 1 }} />
      <Button
        label={t('common.delete')}
        onClick={selection.removeSelected}
        palette={palette}
        fonts={fonts}
        tone={palette.danger || '#ff5a5f'}
        primary
        disabled={selection.selectedCount === 0 || isSending}
      />
    </div>
  );
}