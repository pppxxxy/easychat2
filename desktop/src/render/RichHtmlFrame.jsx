// 富 HTML / HTML 消息的桌面渲染：sandbox iframe + 父页面事件委托。
//
// 关键取舍（design.md 安全决策）：iframe **不启用 allow-scripts**，只开
// allow-same-origin。这样：
//   · 卡片里的 <script> / on* 全部不执行（iframe 文档内 CSP 再写 script-src 'none'）；
//   · 父页面仍能读 contentDocument，于是高度测量、链接处置、命令按钮都不需要
//     往卡片里注入任何脚本——注入脚本本身就是 allow-scripts 之外的另一条风险面。
//
// 高度：ResizeObserver + load 事件回传（与 Android 侧 RICH_HTML_RESIZE_BRIDGE 同一目标，
// 实现从 postMessage 改成父页面直接测量）。视口型文档（100vh/inset:0）按宿主高度固定，
// 超长文档超过滚动阈值后收成预览高度、卡片内滚动。
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  classifyRichHtmlLink,
  isViewportRichHtml,
} from '../../../src/chat/richHtml.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { contentHeightFrom, resolveFrameDisplayHeight } from './frameHeight.js';
import { buildIframeDocument } from './richHtmlDoc.js';

function decodeCommand(raw) {
  const value = String(raw || '');
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

export default function RichHtmlFrame({ html, palette, fonts, onCommand }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const frameRef = useRef(null);
  const [contentHeight, setContentHeight] = useState(160);
  const [accessible, setAccessible] = useState(true);

  const viewportDocument = useMemo(() => isViewportRichHtml(html), [html]);
  const fontSize = fonts.scaled(15);
  const linkColor = palette.primaryMuted || palette.primary;
  const documentHtml = useMemo(() => buildIframeDocument({
    html,
    textColor: palette.text,
    linkColor,
    fontSize,
  }), [html, palette.text, linkColor, fontSize]);

  useEffect(() => {
    setContentHeight(160);
    setAccessible(true);
  }, [documentHtml]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let stopped = false;
    let detachDoc = null;
    let frameRequest = 0;
    const timers = [];

    const handleLink = url => {
      const link = classifyRichHtmlLink(url);
      if (link.kind === 'empty') return;
      if (link.kind === 'external') {
        try {
          getBridge().app.openExternal(link.url).catch(() => {
            Alert.alert(
              tRef.current('chat.richHtml.linkFailed.title'),
              tRef.current('chat.richHtml.linkFailed.body')
            );
          });
        } catch (error) {
          Alert.alert(
            tRef.current('chat.richHtml.linkFailed.title'),
            tRef.current('chat.richHtml.linkFailed.body')
          );
        }
        return;
      }
      Alert.alert(
        tRef.current('chat.richHtml.linkUnsupported.title'),
        tRef.current('chat.richHtml.linkUnsupported.body', {
          scheme: link.scheme || tRef.current('chat.richHtml.linkUnsupported.relative'),
        })
      );
    };

    const attach = () => {
      if (stopped) return;
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch (error) {
        doc = null;
      }
      if (!doc || !doc.body) {
        // 拿不到文档（沙箱策略变化/浏览器拒绝）时退化为固定高度 + 内部滚动，
        // 至少卡片内容仍然可见、可滚。
        setAccessible(false);
        return;
      }
      setAccessible(true);

      const measure = () => {
        if (stopped) return;
        // 只量 body：iframe 的 documentElement.scrollHeight 至少等于视口高度，
        // 用它会把「短卡片」永远撑在当前高度（只能变大、不能变小）。body 是内容盒，
        // 在 min-height:0 覆盖之后如实反映内容高度；body 缺失时才回落到根元素。
        const body = doc.body;
        const next = body
          ? contentHeightFrom(body.scrollHeight, body.offsetHeight)
          : contentHeightFrom(
            doc.documentElement ? doc.documentElement.scrollHeight : 0,
            doc.documentElement ? doc.documentElement.offsetHeight : 0
          );
        setContentHeight(previous => (Math.abs(previous - next) > 2 ? next : previous));
      };
      // 一帧最多量一次：延迟采样与 load/toggle 事件可能在同一帧扎堆。
      const scheduleMeasure = () => {
        if (stopped) return;
        if (frameRequest) cancelAnimationFrame(frameRequest);
        frameRequest = requestAnimationFrame(() => {
          frameRequest = 0;
          measure();
        });
      };

      const onClick = event => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        const anchor = target.closest('a[href]');
        if (anchor) {
          event.preventDefault();
          handleLink(anchor.getAttribute('href'));
          return;
        }
        const button = target.closest('button[data-command]');
        if (button) {
          event.preventDefault();
          const command = decodeCommand(button.getAttribute('data-command')).trim();
          if (command && typeof onCommandRef.current === 'function') {
            onCommandRef.current(command);
          }
        }
      };
      const onSubmit = event => event.preventDefault();

      doc.addEventListener('click', onClick, true);
      doc.addEventListener('submit', onSubmit, true);
      doc.addEventListener('load', scheduleMeasure, true);
      // 不用 ResizeObserver：观察 body + 改 iframe 高度会互相触发，Chromium 会刷
      // 「loop completed with undelivered notifications」。卡片高度变化的来源是确定的
      // （图片加载、<details> 展开、命令按钮改 DOM），用 load/toggle + 几个延迟采样覆盖。
      doc.addEventListener('toggle', scheduleMeasure, true);
      [0, 80, 300, 800].forEach(delay => {
        timers.push(setTimeout(scheduleMeasure, delay));
      });
      detachDoc = () => {
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('submit', onSubmit, true);
        doc.removeEventListener('load', scheduleMeasure, true);
        doc.removeEventListener('toggle', scheduleMeasure, true);
      };
    };

    frame.addEventListener('load', attach);
    // srcdoc 可能在 effect 之前就完成加载（React 插入即解析），补一次直接挂载。
    attach();
    return () => {
      stopped = true;
      if (frameRequest) cancelAnimationFrame(frameRequest);
      timers.forEach(timer => clearTimeout(timer));
      frame.removeEventListener('load', attach);
      if (detachDoc) detachDoc();
    };
  }, [documentHtml]);

  const displayHeight = viewportDocument
    ? 'min(520px, 62vh)'
    : resolveFrameDisplayHeight(contentHeight, accessible);

  return (
    <div
      style={{
        width: '100%',
        minWidth: 0,
        marginTop: 8,
        border: `1px solid ${palette.divider}`,
        borderRadius: 10,
        overflow: 'hidden',
        background: palette.surfaceAlt,
      }}
    >
      <iframe
        ref={frameRef}
        title={t('chat.richHtml.cardTitle')}
        sandbox="allow-same-origin"
        srcDoc={documentHtml}
        style={{
          display: 'block',
          width: '100%',
          height: displayHeight,
          border: 'none',
          background: 'transparent',
        }}
      />
    </div>
  );
}
