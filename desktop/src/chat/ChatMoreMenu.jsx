// 聊天页「更多」菜单（桌面）：把手机上「⋯ 菜单」里的会话级动作收在一处。
//
// 为什么单独一个弹出层而不是继续往输入框工具栏塞按钮：工具栏已有 6 个图标按钮
// （图片/视频/文本/表情/语音/搜索），再往上堆统计、导出、总结会把输入区挤没。
// 手机版也是同一个理由——这些都在 ⋯ 菜单里，而不是在一排图标里。
//
// 条目顺序与手机 MoreMenuModal 的「会话」分组保持一致；桌面上不可用的项
// （全屏编辑 / 定位 / 模型 / 思考 / 语音）不列出——隐藏而不是列出来点了没反应。
import { useEffect, useRef } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function ChatMoreMenu({
  open,
  anchor,
  onClose,
  onToggleSearch,
  searchOpen,
  onSummarize,
  summarizing,
  canSummarize,
  onOpenStats,
  onOpenExport,
  canExport,
  onReselectGreeting,
  canReselectGreeting,
  onOpenFullScreen,
  canFullScreen,
  onOpenScrubber,
  canScrubber,
  onOpenSelection,
  canSelect,
  onEditRole,
  onOpenModel,
  onOpenThinking,
  canSwitchModel,
  autoBroadcast,
  onToggleAutoBroadcast,
  onOpenConversationCard,
  canConversationCard,
  onOpenSwitcher,
  isGroup,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = event => {
      if (boxRef.current && !boxRef.current.contains(event.target)) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const items = [
    {
      key: 'search',
      label: t('chat.menu.search'),
      active: searchOpen,
      onClick: onToggleSearch,
    },
    {
      key: 'summary',
      label: summarizing ? t('chat.menu.summarizing') : t('chat.menu.summary'),
      disabled: !!summarizing || !canSummarize,
      onClick: onSummarize,
    },
    {
      key: 'fullscreen',
      label: t('chat.menu.fullscreen'),
      disabled: !canFullScreen,
      onClick: onOpenFullScreen,
    },
    {
      key: 'scrubber',
      label: t('chat.menu.scrubber'),
      disabled: !canScrubber,
      onClick: onOpenScrubber,
    },
    {
      key: 'select',
      label: t('chat.bubble.selectMessage'),
      disabled: !canSelect,
      onClick: onOpenSelection,
    },
    {
      key: 'switcher',
      label: t('chat.switcher.title'),
      onClick: onOpenSwitcher,
    },
    {
      key: 'conversation-card',
      label: t('desktop.conversationCard.title'),
      disabled: !canConversationCard,
      onClick: onOpenConversationCard,
    },
    // 编辑角色/群聊：手机把这项提为一等公民（原来藏在二级弹层里）。
    onEditRole ? {
      key: 'edit-role',
      label: isGroup ? t('chat.editGroup') : t('chat.editCharacter'),
      onClick: onEditRole,
    } : null,
    {
      key: 'model',
      label: t('chat.menu.model'),
      disabled: !canSwitchModel,
      onClick: onOpenModel,
    },
    {
      key: 'thinking',
      label: t('chat.menu.thinking'),
      disabled: !canSwitchModel,
      onClick: onOpenThinking,
    },
    {
      // 自动播报：与手机 VoiceSettingsModal 的开关同一语义（手动播报不受它限制）。
      key: 'auto-broadcast',
      label: `${t('tts.autoBroadcast.title')}${autoBroadcast ? ' ✓' : ''}`,
      active: !!autoBroadcast,
      onClick: () => onToggleAutoBroadcast(!autoBroadcast),
    },
    {
      key: 'stats',
      label: t('chat.menu.sessionStats'),
      onClick: onOpenStats,
    },
    {
      key: 'export',
      label: t('chat.menu.export'),
      disabled: !canExport,
      onClick: onOpenExport,
    },
    // 群聊没有「开场白」概念（首条消息由调度器生成），只在单聊里给这个入口。
    isGroup ? null : {
      key: 'greeting',
      label: t('chat.bubble.reselect'),
      disabled: !canReselectGreeting,
      onClick: onReselectGreeting,
    },
  ].filter(Boolean);

  const left = Math.max(8, Math.min(anchor ? anchor.x : 8, window.innerWidth - 220));
  const top = Math.max(8, Math.min(anchor ? anchor.y : 8, window.innerHeight - 40 - items.length * 34));

  return (
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 56,
        minWidth: 190,
        background: palette.surface,
        border: `1px solid ${palette.divider}`,
        borderRadius: 10,
        padding: 6,
        boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            Promise.resolve(item.onClick()).catch(() => {});
          }}
          style={{
            textAlign: 'left',
            background: item.active ? palette.surfaceAlt : 'transparent',
            border: 'none',
            borderRadius: 6,
            color: item.disabled ? palette.textFaint : palette.text,
            padding: '7px 10px',
            fontSize: fonts.scaled(12),
            cursor: item.disabled ? 'default' : 'pointer',
            opacity: item.disabled ? 0.6 : 1,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}