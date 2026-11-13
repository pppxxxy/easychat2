// 消息操作菜单（桌面）：复制 / 引用 / 选择文本 / 编辑重发 / 重新生成 / 删除图片消息。
//
// 与 Android MessageBubble 的「⋯」菜单同口径，但用桌面弹出层而不是底部 Sheet。
// 文案全部走既有词条（chat.bubble.*），不新增。
import { useEffect, useRef } from 'react';

import { maskSecrets } from '../../../src/storage/secrets.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { messageCopyText } from '../../../src/chat/plainText.js';

export default function MessageActionsMenu({
  message,
  anchor,
  palette,
  fonts,
  onClose,
  onQuote,
  onRegenerate,
  onEditUserMessage,
  onDeleteImageMessage,
  onBroadcast,
  canRegenerate,
}) {
  const { t } = useTranslation();
  const boxRef = useRef(null);

  useEffect(() => {
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
  }, [onClose]);

  if (!message || !anchor) return null;
  const isUser = message.role === 'user';
  const isMedia = !!message.image;
  const text = isMedia ? '' : messageCopyText(message.text);
  const raw = isMedia ? '' : String(message.text || '');

  const items = [];
  if (isMedia) {
    if (onQuote) items.push({ key: 'quote', label: t('chat.bubble.quote'), onPress: () => onQuote(message) });
    if (isUser && onEditUserMessage) items.push({ key: 'edit', label: t('chat.bubble.editResend'), onPress: () => onEditUserMessage(message.id) });
    if (onDeleteImageMessage) items.push({ key: 'delete', label: t('chat.bubble.deleteMessage'), onPress: () => onDeleteImageMessage(message.id) });
  } else {
    items.push({
      key: 'copy',
      label: t('common.copy'),
      onPress: async () => {
        try {
          await getBridge().clipboard.write(maskSecrets(text || raw));
        } catch (error) {
          Alert.alert(t('common.error.retryLater'));
        }
      },
    });
    // 手动播报：只对助手消息（播报自己的话没意义）；不受自动播报开关限制。
    if (!isUser && onBroadcast) {
      items.push({ key: 'broadcast', label: t('chat.bubble.broadcast'), onPress: () => onBroadcast(message) });
    }
    if (!isUser) {
      items.push({
        key: 'copy-raw',
        label: t('chat.bubble.selectText'),
        onPress: async () => {
          try {
            await getBridge().clipboard.write(maskSecrets(raw));
          } catch (error) {}
        },
      });
    }
    if (onQuote) items.push({ key: 'quote', label: t('chat.bubble.quote'), onPress: () => onQuote(message) });
    if (isUser && onEditUserMessage) {
      items.push({ key: 'edit', label: t('chat.bubble.editResend'), onPress: () => onEditUserMessage(message.id) });
    } else if (!isUser && canRegenerate && onRegenerate) {
      items.push({ key: 'regenerate', label: t('chat.bubble.regenerate'), onPress: () => onRegenerate(message.id) });
    }
  }

  const left = Math.min(Math.max(8, anchor.x), Math.max(8, window.innerWidth - 220));
  const top = Math.min(Math.max(8, anchor.y), Math.max(8, window.innerHeight - 40 - items.length * 34));

  return (
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 55,
        minWidth: 180,
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
          onClick={() => {
            onClose();
            Promise.resolve(item.onPress()).catch(() => {});
          }}
          style={{
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            color: palette.text,
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: fonts.scaled(12),
            cursor: 'pointer',
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}