// 分叉点入口（桌面）：在「此处另有 N 条分支」的消息之后插入一条可展开的内联条。
//
// 对应手机 chat/BranchForkRow。与 ChatPane 里已有的 BranchSwitcher（< N///M >）分工不同：
//   · BranchSwitcher 只做「同一轮回复的上一版/下一版」线性翻页；
//   · 本组件在**分叉点**展开该点的全部分支（预览 + 时间），可切换或删除。
// 两者都在共享层 branchTree 的分组结果之上，不各自算一遍。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

function formatBranchTime(timestamp, locale) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (error) {
    return '';
  }
}

export default function BranchForkRow({
  forkMessageId,
  branches,
  onCheckout,
  onDelete,
  disabled,
  palette,
  fonts,
}) {
  const { t, localeId } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const count = Array.isArray(branches) ? branches.length : 0;
  if (count === 0) return null;

  const label = forkMessageId
    ? t('chat.branch.forkEntry', { count })
    : t('chat.branch.forkEntryRoot', { count });

  const run = async (branch, action) => {
    if (busyId || disabled) return;
    setBusyId(branch.id);
    try {
      await action(branch);
    } finally {
      setBusyId('');
    }
  };

  return (
    <div style={{ margin: '2px 0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-label={t('chat.branch.expandA11y')}
        aria-expanded={expanded}
        style={{
          textAlign: 'left',
          alignSelf: 'flex-start',
          background: 'transparent',
          color: palette.textMuted,
          border: `1px dashed ${palette.divider}`,
          borderRadius: 8,
          padding: '3px 10px',
          cursor: 'pointer',
          fontSize: fonts.scaled(11),
        }}
      >
        {expanded ? '▾' : '▸'} {label}
      </button>
      {expanded ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          paddingLeft: 10,
          borderLeft: `2px solid ${palette.divider}`,
        }}
        >
          {branches.map(branch => (
            <div
              key={branch.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: `1px solid ${palette.divider}`,
                borderRadius: 8,
                padding: '6px 8px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{
                  fontSize: fonts.scaled(11),
                  color: palette.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {String(branch.preview || '').trim() || t('chat.branch.emptyPreview')}
                </span>
                <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                  {formatBranchTime(branch.createdAt, localeId)}
                  {' · '}
                  {t('chat.branch.countMeta', { count: Number(branch.messageCount) || 0 })}
                </span>
              </div>
              <Button
                label={t('chat.branch.checkout')}
                onClick={() => run(branch, onCheckout)}
                palette={palette}
                fonts={fonts}
                disabled={disabled || busyId === branch.id}
              />
              <Button
                label={t('chat.branch.delete')}
                onClick={() => run(branch, onDelete)}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
                disabled={disabled || busyId === branch.id}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
