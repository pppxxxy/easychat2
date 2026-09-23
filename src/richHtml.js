// 富 HTML 消息的判定与文档包装（纯函数，便于单测）。
// 含 <style> / <script> / <details> 等内置渲染器不支持的标签时用 WebView 渲染，
// 才能还原角色卡的样式、折叠与交互；其余普通 HTML 仍交给内置渲染器。

// 这些标签 react-native-render-html 处理不好或直接丢弃：<style> 被删、<script> 不执行、
// <details>/<summary> 归为不可翻译标签、SVG 不支持，因此都改用 WebView 渲染。
const RICH_HTML_TAG_PATTERN = /<(?:script|style|details|summary|svg|audio|video)[\s>]/i;
const COLLAPSIBLE_HTML_TAG_PATTERN = /<(?:details|summary)[\s>]/i;
// 角色卡常把 HTML 包在 ```html 围栏里；无论内置渲染还是 WebView 渲染，
// 围栏都应先去掉，否则会当成正文显示。
const MARKDOWN_FENCE_LINE_PATTERN = /^[ \t]*```[^\n]*$/gm;

export function stripMarkdownFences(text) {
  return String(text || '').replace(MARKDOWN_FENCE_LINE_PATTERN, '');
}

export function needsRichHtmlRendering(text) {
  return RICH_HTML_TAG_PATTERN.test(String(text || ''));
}

export function shouldRenderRichHtml(text, enabled) {
  const value = String(text || '');
  return needsRichHtmlRendering(value)
    && (enabled !== false || COLLAPSIBLE_HTML_TAG_PATTERN.test(value));
}

// WebView 不能自带高度：用 ResizeObserver 把 body 高度回传，同时把
// button[data-command] 的点击桥接回 App。
export const RICH_HTML_RESIZE_BRIDGE = [
  '<script>',
  '(function(){',
  '  function send(payload){',
  '    try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}',
  '  }',
  '  if (typeof window.triggerSlash !== "function") {',
  '    window.triggerSlash = function(command){',
  '      var value = String(command || "");',
  '      if (value.indexOf("/send ") === 0) value = value.slice(7);',
  '      send({ type: "command", value: value });',
  '    };',
  '  }',
  '  function measure(){',
  '    var b = document.body;',
  '    var d = document.documentElement;',
  '    var r = b && typeof b.getBoundingClientRect === "function" ? b.getBoundingClientRect() : null;',
  '    var h = Math.max(',
  '      b ? b.scrollHeight : 0,',
  '      b ? b.offsetHeight : 0,',
  '      r ? r.height : 0,',
  '      b ? 0 : (d ? d.scrollHeight : 0)',
  '    );',
  '    send({ type: "height", value: h });',
  '  }',
  '  function init(){',
  '    measure();',
  '    if (window.ResizeObserver && document.body) { try { new ResizeObserver(measure).observe(document.body); } catch (e) {} }',
  '    window.addEventListener("load", measure);',
  '    setTimeout(measure, 50);',
  '    setTimeout(measure, 250);',
  '    setTimeout(measure, 800);',
  '    function schedule(){',
  '      if (window.requestAnimationFrame) window.requestAnimationFrame(measure);',
  '      setTimeout(measure, 0);',
  '      setTimeout(measure, 80);',
  '      setTimeout(measure, 300);',
  '      setTimeout(measure, 700);',
  '    }',
  '    document.addEventListener("toggle", schedule, true);',
  '    document.addEventListener("click", schedule, true);',
  '    document.addEventListener("click", function(ev){',
  '      var el = ev.target;',
  '      while (el && el !== document.body) {',
  '        if (el.tagName === "BUTTON" && el.dataset && el.dataset.command) {',
  '          send({ type: "command", value: el.dataset.command });',
  '          ev.preventDefault();',
  '          return;',
  '        }',
  '        el = el.parentElement;',
  '      }',
  '    }, true);',
  '  }',
  '  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }',
  '})();',
  '</script>',
].join('\n');

function buildRichHtmlLayoutStyle(resetMaxHeight = true) {
  const rules = [];
  if (resetMaxHeight) rules.push('body *{max-height:none !important;}');
  rules.push(
    'html,body{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:hidden!important;}',
    'body,body *{overflow-wrap:anywhere!important;word-break:break-word!important;}',
    'details{display:block!important;width:100%!important;max-width:100%!important;flex:0 0 100%!important;align-self:stretch!important;clear:both!important;}',
    'details>summary{display:flex!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;}',
    'details>div{width:100%!important;max-width:100%!important;}'
  );
  return rules.join('');
}

function extractFullHtmlDocument(value) {
  const start = value.search(/<!doctype\s+html\b|<html[\s>]/i);
  if (start < 0) return null;
  const end = value.toLowerCase().lastIndexOf('</html>');
  if (end < start) return null;
  return value.slice(start, end + '</html>'.length);
}

function injectFullDocumentSupport(documentHtml, layoutStyle) {
  let output = documentHtml;
  const styleBlock = `<style data-easychat2-runtime="true">${layoutStyle}</style>`;
  if (/<\/head>/i.test(output)) {
    output = output.replace(/<\/head>/i, `${styleBlock}</head>`);
  } else if (/<head\b[^>]*>/i.test(output)) {
    output = output.replace(/(<head\b[^>]*>)/i, `$1${styleBlock}`);
  } else if (/<html\b[^>]*>/i.test(output)) {
    output = output.replace(/(<html\b[^>]*>)/i, `$1<head>${styleBlock}</head>`);
  } else {
    return null;
  }
  if (/<\/body>/i.test(output)) {
    output = output.replace(/<\/body>/i, `${RICH_HTML_RESIZE_BRIDGE}</body>`);
  } else {
    output += RICH_HTML_RESIZE_BRIDGE;
  }
  return output;
}

export function buildRichHtmlDocument({
  bodyHtml = '',
  textColor = '#e8e8f0',
  linkColor = '#6c63ff',
  fontSize = 15,
  fontFamily = '',
} = {}) {
  const normalizedBody = stripMarkdownFences(bodyHtml).trim();
  const layoutStyle = buildRichHtmlLayoutStyle();
  const fullDocument = extractFullHtmlDocument(normalizedBody);
  if (fullDocument) {
    const supportedDocument = injectFullDocumentSupport(fullDocument, buildRichHtmlLayoutStyle(false));
    if (supportedDocument) return supportedDocument;
  }
  const fontRule = fontFamily ? `font-family:${fontFamily};` : '';
  return (
    '<!DOCTYPE html><html><head>'
    + '<meta charset="utf-8"/>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>'
    + '<style>'
    + 'html,body{margin:0;padding:0;background:transparent;height:auto;}'
    + `body{color:${textColor};font-size:${fontSize}px;line-height:1.6;word-break:break-word;-webkit-text-size-adjust:100%;${fontRule}}`
    + 'img{max-width:100%!important;height:auto;}'
    + `a{color:${linkColor};}`
    + '*{box-sizing:border-box;}'
    + layoutStyle
    + '</style></head>'
    + `<body>${normalizedBody}${RICH_HTML_RESIZE_BRIDGE}</body></html>`
  );
}
