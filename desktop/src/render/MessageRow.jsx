// 单条消息渲染（桌面首版）：纯文本 / Markdown / 富 HTML / 媒体 / 错误气泡。
import { useEffect, useMemo, useState } from 'react';

import { maskSecrets } from '../../../src/storage/secrets.js';
import { resolveBubbleStyle } from '../../../src/chat/bubbleStyle.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { getBridge } from '../platform/bridge.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import MediaMessage from './MediaMessage.jsx';
import RichHtmlFrame from './RichHtmlFrame.jsx';
import { renderMarkdownHtml } from './markdown.js';
import { RENDER_KIND, resolveMessageRenderKind } from './messageRenderKind.js';

function PendingDots({ palette }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', height: 18 }}>
      {[0, 1, 2].map(index => (
        <span
          key={index}
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            background: palette.textFaint,
            animation: 'ec-pending 1s ease-in-out infinite',
            animationDelay: `${index * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}

function Reasoning({ text, palette, fonts }) {
  const { t } = useTranslation();
  if (!String(text || '').trim()) return null;
  return (
    <details style={{ marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer', color: palette.textFaint, fontSize: fonts.scaled(12), userSelect: 'none' }}>
        {t('chat.bubble.thinking')}
      </summary>
      <div style={{
        marginTop: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: palette.surfaceAlt,
        color: palette.textMuted,
        fontSize: fonts.scaled(12),
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
      >
        {String(text)}
      </div>
    </details>
  );
}

function Quote({ quoted, palette, fonts }) {
  const { t } = useTranslation();
  if (!quoted || !quoted.text) return null;
  return (
    <div style={{
      marginBottom: 8,
      padding: '6px 10px',
      borderLeft: `3px solid ${palette.primaryMuted || palette.primary}`,
      borderRadius: '0 8px 8px 0',
      background: palette.surfaceAlt,
      maxWidth: '100%',
    }}
    >
      <div style={{ fontSize: fonts.scaled(11), fontWeight: 700, color: palette.textMuted, marginBottom: 2 }}>
        {quoted.name || t('chat.bubble.quoteOriginal')}
      </div>
      <div style={{
        fontSize: fonts.scaled(12),
        color: palette.textMuted,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
      >
        {String(quoted.text)}
      </div>
    </div>
  );
}

function ErrorBubble({ message, palette, fonts }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = maskSecrets(message.detail || message.text || '');
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await getBridge().clipboard.write(detail);
      setCopied(true);
    } catch (error) {
      // 复制失败不改变气泡状态：错误详情仍可展开查看。
    }
  };
  return (
    <div style={{
      maxWidth: '76%',
      background: palette.surface,
      border: `1px solid ${palette.danger || '#ff5a5f'}`,
      borderRadius: 12,
      padding: '10px 14px',
      color: palette.text,
      fontSize: fonts.scaled(13),
    }}
    >
      <div style={{ color: palette.danger || '#ff5a5f', fontWeight: 700, fontSize: fonts.scaled(12), marginBottom: 4 }}>
        {t('chat.error.badge')}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        style={{ background: 'transparent', border: 'none', color: palette.text, padding: 0, cursor: 'pointer', textAlign: 'left', fontSize: fonts.scaled(13) }}
      >
        {t('chat.error.summary')}
      </button>
      {expanded ? (
        <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: palette.textMuted, fontSize: fonts.scaled(12) }}>
          {detail}
        </div>
      ) : null}
      <button
        type="button"
        onClick={copy}
        style={{
          marginTop: 8,
          background: palette.surfaceAlt,
          border: `1px solid ${palette.divider}`,
          borderRadius: 8,
          color: palette.textMuted,
          padding: '4px 10px',
          fontSize: fonts.scaled(11),
          cursor: 'pointer',
        }}
      >
        {copied ? t('common.copied') : t('chat.error.copy')}
      </button>
    </div>
  );
}

export default function MessageRow({
  message,
  palette,
  fonts,
  tokens,
  bubbleStyle,
  onRegenerate,
  onCommand,
  onMenu,
  onGenerateImage = null,
  speakerName = '',
}) {
  const { t } = useTranslation();
  const kind = resolveMessageRenderKind(message);
  const markdown = useMemo(
    () => (kind === RENDER_KIND.MARKDOWN ? renderMarkdownHtml(message.text) : null),
    [kind, message.text]
  );
  if (kind === RENDER_KIND.EMPTY) return null;

  const isUser = message.role === 'user';
  const isError = kind === RENDER_KIND.ERROR;
  const isMedia = kind === RENDER_KIND.MEDIA;
  const text = String(message.text || '');
  // 气泡样式（圆润 / 卡片 / 无底纹）：决策在共享层 resolveBubbleStyle，
  // 这里只把结果映射到 DOM 的 inline style —— 设置里的「气泡样式」因此真的生效。
  const bubble = resolveBubbleStyle(bubbleStyle, { colors: palette }, tokens || {});
  const bubbleBackground = isMedia
    ? 'transparent'
    : (isUser ? bubble.userBackground : bubble.assistantBackground);
  const bubbleTextColor = isUser ? bubble.userTextColor : palette.text;
  const markdownVars = {
    '--ec-surface-alt': palette.surfaceAlt,
    '--ec-border': palette.divider,
    '--ec-link': palette.primaryMuted || palette.primary,
  };

  return (
    <div
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}
      onContextMenu={event => {
        if (!onMenu || message.pending) return;
        event.preventDefault();
        onMenu(message, { x: event.clientX + 2, y: event.clientY + 2 });
      }}
    >
      {isError ? (
        <ErrorBubble message={message} palette={palette} fonts={fonts} />
      ) : (
        <div style={{
          maxWidth: isMedia ? '76%' : '82%',
          minWidth: 0,
          background: bubbleBackground,
          color: bubbleTextColor,
          border: isMedia || bubble.plain ? 'none' : (isUser ? 'none' : `1px solid ${palette.divider}`),
          // 圆润风格给「收角」方向感（用户右侧、助手左侧），卡片/无底纹四角一致。
          borderRadius: isUser
            ? `${bubble.bubbleRadius}px ${bubble.tailRadius}px ${bubble.bubbleRadius}px ${bubble.bubbleRadius}px`
            : `${bubble.tailRadius}px ${bubble.bubbleRadius}px ${bubble.bubbleRadius}px ${bubble.bubbleRadius}px`,
          padding: isMedia ? 0 : `${bubble.bubblePaddingVertical}px ${bubble.bubblePaddingHorizontal}px`,
          boxShadow: isMedia || !bubble.hasShadow ? 'none' : '0 1px 2px rgba(0,0,0,0.12)',
          fontSize: fonts.scaled(14),
          lineHeight: 1.65,
          wordBreak: 'break-word',
        }}
        >
          {!isUser && String(speakerName || '').trim() ? (
            <div style={{
              marginBottom: 4,
              fontSize: fonts.scaled(11),
              fontWeight: 700,
              color: palette.primaryMuted || palette.primary,
            }}
            >
              {String(speakerName).trim()}
            </div>
          ) : null}
          {!isUser ? <Reasoning text={message.reasoning} palette={palette} fonts={fonts} /> : null}
          <Quote quoted={message.quoted} palette={palette} fonts={fonts} />
          {isMedia ? (
            <MediaMessage image={message.image} kind={message.kind} palette={palette} fonts={fonts} />
          ) : kind === RENDER_KIND.HTML ? (
            <RichHtmlFrame
              html={text}
              palette={palette}
              fonts={fonts}
              onCommand={onCommand}
            />
          ) : kind === RENDER_KIND.PENDING ? (
            <PendingDots palette={palette} />
          ) : kind === RENDER_KIND.MARKDOWN ? (
            <div
              className="ec-md"
              style={markdownVars}
              dangerouslySetInnerHTML={{ __html: markdown.html }}
            />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
          )}
          {isMedia && text.trim() ? (
            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{text}</div>
          ) : null}
          {message.pending && !isMedia && kind !== RENDER_KIND.PENDING ? (
            <span style={{ opacity: 0.65 }}> …</span>
          ) : null}
          {/* 自动配图：与手机同一套三态（loading / error+重试 / 图）。只在助手消息上出现。 */}
          {!isUser && message.inlineImage ? (
            <div style={{ marginTop: 8 }} data-inline-image-state={message.inlineImage.status}>
              {message.inlineImage.status === 'loading' ? (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: palette.surfaceAlt,
                  color: palette.textMuted,
                  fontSize: fonts.scaled(11),
                }}
                >
                  {t('chat.bubble.inlineLoading')}
                </div>
              ) : message.inlineImage.status === 'error' ? (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: palette.surfaceAlt,
                  color: palette.danger || '#ff5a5f',
                  fontSize: fonts.scaled(11),
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {message.inlineImage.message || t('chat.bubble.inlineError')}
                  </span>
                  {onGenerateImage ? (
                    <button
                      type="button"
                      onClick={() => onGenerateImage(message.id, message.text)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: palette.primaryMuted || palette.primary,
                        cursor: 'pointer',
                        fontSize: fonts.scaled(11),
                        padding: 0,
                      }}
                    >
                      {t('common.retry')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <img
                  src={mediaUrl(message.inlineImage.uri || message.inlineImage.url)
                    || (message.inlineImage.base64
                      ? `data:image/png;base64,${message.inlineImage.base64}`
                      : '')}
                  alt=""
                  style={{
                    maxWidth: '100%',
                    borderRadius: 8,
                    border: `1px solid ${palette.divider}`,
                    display: 'block',
                  }}
                />
              )}
            </div>
          ) : null}
          {!isUser && !message.pending ? (
            <>
              {onRegenerate ? (
                <button
                  type="button"
                  onClick={() => onRegenerate(message.id)}
                  title={t('chat.bubble.regenerate')}
                  style={{
                    marginLeft: 10,
                    background: 'transparent',
                    border: 'none',
                    color: palette.textMuted,
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: 0,
                  }}
                >
                  ↻
                </button>
              ) : null}
              {typeof onMenu === 'function' ? (
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onMenu(message, { x: rect.left, y: rect.bottom + 4 });
                  }}
                  title={t('chat.bubble.moreA11y')}
                  style={{
                    marginLeft: 8,
                    background: 'transparent',
                    border: 'none',
                    color: palette.textFaint,
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: 0,
                  }}
                >
                  ⋯
                </button>
              ) : null}
            </>
          ) : null}
          {isUser && !message.pending && typeof onMenu === 'function' ? (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(message, { x: rect.left - 180, y: rect.bottom + 4 });
              }}
              title={t('chat.bubble.moreA11y')}
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                color: 'rgba(0,0,0,0.4)',
                cursor: 'pointer',
                fontSize: 13,
                padding: 0,
              }}
            >
              ⋯
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
