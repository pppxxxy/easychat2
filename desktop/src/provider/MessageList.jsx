// 消息列表（桌面）：一条消息 = 勾选角标（多选态）+ 气泡 + 版本切换器。
//
// 从 provider/ChatPane.jsx 外提（那里撞到 800 行棘轮）。这里是纯展示组件：
// 所有状态（搜索聚焦、多选、分支导航）都由宿主传入回调，本文件不持有任何状态，
// 也不读存储——这样它才能被单独读懂、也才不会再把 ChatPane 撑爆。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
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
  // 分支
  branchNav,
  onCheckoutBranch,
  branchDisabled,
}) {
  useTranslation(); // 保持与其余面板一致的翻译订阅（本文件暂无自有文案）
  const selectedSet = new Set(selectedIds || []);
  const quoteId = String(focusedId || '');

  return (
    <>
      {messages.map(message => {
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
              speakerName={isGroup && !message.isUser && message.role !== 'user' && speakerNameOf
                ? speakerNameOf(message, memberNames, groupName)
                : ''}
            />
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