// 全屏输入（桌面）：把长文本编辑挪到一个大面板里，写完直接发送。
//
// 对应手机 chat/FullScreenInputModal。手机上它的理由是软键盘把输入框挤得只剩两行；
// 桌面上同等理由是长提示词/角色卡正文在 2 行高的小输入框里难以通读与改句。
//
// 行为与聊天页输入区严格一致：
//   · 文本来自同一个 input store（getInput），改一个字就写回同处，不是第二份草稿；
//   · 发送走 ChatPane 的 submit（含开场白拦截、附件校验、会话竞态守卫）；
//   · 打开期间不影响主输入框（它订阅同一个 store，会同步显示）。
//
// 快捷键：Ctrl/Cmd+Enter 发送、Esc 关闭（桌面用户的预期）。
import { useEffect, useRef } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Button } from '../settings/ui.jsx';

export default function FullScreenInput({
  open,
  value,
  onChange,
  onSend,
  onClose,
  palette,
  fonts,
  sendLabel,
}) {
  const { t } = useTranslation();
  const textareaRef = useRef(null);

  // 打开时聚焦并把光标放到末尾（用户多半是接着写）。
  useEffect(() => {
    if (!open) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      // 回车换行、Ctrl/Cmd+回车发送——与主输入框「回车发送、Shift+回车换行」不冲突，
      // 因为这里是多行编辑场景（主输入框的约定在长文本下会很别扭）。
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSend();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, onSend]);

  if (!open) return null;

  const canSend = !!String(value || '').trim();

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 53,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(760px, 96vw)',
          height: 'min(78vh, 720px)',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 16,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
          <strong style={{ fontSize: fonts.scaled(14) }}>{t('chat.fullscreen.title')}</strong>
          <button
            type="button"
            onClick={onClose}
            title={t('chat.fullscreen.closeA11y')}
            aria-label={t('chat.fullscreen.closeA11y')}
            style={{ background: 'transparent', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: 18 }}
          >
            ×
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={t('chat.composer.placeholder')}
          style={{
            flex: 1,
            minHeight: 0,
            resize: 'none',
            background: palette.surfaceAlt,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            padding: '12px 14px',
            fontSize: fonts.scaled(14),
            lineHeight: 1.75,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flex: 'none' }}>
          <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
          <Button
            label={sendLabel || t('chat.fullscreen.send')}
            onClick={onSend}
            palette={palette}
            fonts={fonts}
            primary
            disabled={!canSend}
          />
        </div>
      </div>
    </div>
  );
}