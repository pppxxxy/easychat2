// 消息列表（桌面）：一条消息 = 勾选角标（多选态）+ 气泡 + 版本切换器。
//
// 从 provider/ChatPane.jsx 外提（那里撞到 800 行棘轮）。这里是纯展示组件：
// 所有状态（搜索聚焦、多选、分支导航）都由宿主传入回调，本文件不持有任何状态，
// 也不读存储——这样它才能被单独读懂、也才不会再把 ChatPane 撑爆。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import BranchForkRow from '../chat/BranchForkRow.jsx';
import BranchSwitcher from '../chat/BranchSwitcher.jsx';
import MessageRow from '../render/MessageRow.jsx';

export default function MessageList({
  messages,
  palette,
  fonts,
  // 多选
  selecting,
  selectedIds,
  onToggleSelect,
  // 搜索定位
  focusedId,
  // 群聊发言人
  speakerNameOf,
  isGroup,
  memberNames,
  groupName,
  // 消息动作
  onRegenerate,
  onCommand,
  onMenu,
  onGenerateImage = null,
  // 窗口化（与手机同一语义）：只渲染尾部 windowSize 条，更早的用「加载更早消息」放开。
  windowSize = 0,
  onExpandWindow = null,
  // 分支
  branchNav,
  forkBranches,
  onCheckoutBranch,
  onDeleteBranch,
  branchDisabled,
}) {
  const { t } = useTranslation();
  const selectedSet = new Set(selectedIds || []);
  const quoteId = String(focusedId || '');
  // 窗口化是**数据层**裁剪（不是虚拟化）：手机端 80/200 起步，桌面同口径。
  // 上千条会话若全量挂载，每次打字/滚动都会重算全部气泡的 markdown —— 那才是卡顿源。
  // windowSize 为 0（默认）时保持旧行为，供不关心长会话的调用方使用。
  const total = messages.length;
  const visible = windowSize > 0 && total > windowSize
    ? messages.slice(total - windowSize)
    : messages;
  const hiddenCount = total - visible.length;

  return (
    <>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => (typeof onExpandWindow === 'function' ? onExpandWindow() : undefined)}
          style={{
            display: 'block',
            width: '100%',
            margin: '4px 0 10px',
            padding: '6px 10px',
            background: 'transparent',
            color: palette.textMuted,
            border: `1px dashed ${palette.divider}`,
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: fonts.scaled(11),
          }}
        >
          {t('chat.list.loadEarlier', { count: hiddenCount })}
        </button>
      ) : null}
      {visible.map(message => {
        const id = String(message.id || '');
        const selected = selecting && id && selectedSet.has(id);
        return (
          <div
            key={message.id || `${message.role}-${message.text}`}
            // 搜索跳转用：桌面不是虚拟列表，靠这个锚点 scrollIntoView。
            data-message-id={id}
            onClick={selecting && id ? () => onToggleSelect(id) : undefined}
            role={selecting ? 'button' : undefined}
            tabIndex={selecting ? 0 : undefined}
            onKeyDown={selecting && id ? event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggleSelect(id);
              }
            } : undefined}
            style={{
              position: 'relative',
              cursor: selecting ? 'pointer' : 'default',
              ...(quoteId && id === quoteId
                ? {
                  outline: `2px solid ${palette.primaryMuted || palette.primary}`,
                  outlineOffset: 4,
                  borderRadius: 12,
                }
                : {}),
              ...(selected ? { background: palette.surfaceAlt, borderRadius: 10 } : {}),
            }}
          >
            {selecting ? (
              <span style={{
                position: 'absolute',
                right: 2,
                top: 0,
                width: 18,
                height: 18,
                borderRadius: 9,
                border: `1px solid ${selected ? palette.primary : palette.divider}`,
                background: selected ? palette.primary : palette.surface,
                color: palette.primaryContrast,
                fontSize: 11,
                lineHeight: '16px',
                textAlign: 'center',
                zIndex: 2,
              }}
              >
                {selected ? '✓' : ''}
              </span>
            ) : null}
            <MessageRow
              message={message}
              palette={palette}
              fonts={fonts}
              onRegenerate={onRegenerate}
              onCommand={onCommand}
              onMenu={onMenu}
              onGenerateImage={onGenerateImage}
              speakerName={isGroup && !message.isUser && message.role !== 'user' && speakerNameOf
                ? speakerNameOf(message, memberNames, groupName)
                : ''}
            />
            {/* 分叉点入口：该点有未激活的分支时展开可选（比线性翻页更完整）。 */}
            {onDeleteBranch && forkBranches && forkBranches.get(id) ? (
              <BranchForkRow
                forkMessageId={id}
                branches={forkBranches.get(id)}
                onCheckout={onCheckoutBranch}
                onDelete={onDeleteBranch}
                disabled={branchDisabled}
                palette={palette}
                fonts={fonts}
              />
            ) : null}
            {branchNav && branchNav.get(id) ? (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: -8, marginBottom: 6, paddingLeft: 4 }}>
                <BranchSwitcher
                  nav={branchNav.get(id)}
                  onPrev={() => {
                    const nav = branchNav.get(id);
                    const target = nav && nav.branches.find(branch => branch.id === nav.prevId);
                    if (target) onCheckoutBranch(target);
                  }}
                  onNext={() => {
                    const nav = branchNav.get(id);
                    const target = nav && nav.branches.find(branch => branch.id === nav.nextId);
                    if (target) onCheckoutBranch(target);
                  }}
                  disabled={branchDisabled}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}