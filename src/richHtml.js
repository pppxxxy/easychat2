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
  const source = String(text || '');
  const protectedBlocks = [];
  const protectedText = source.replace(/<(pre|code)\b[\s\S]*?<\/\1\s*>/gi, block => {
    const token = `\uE000RICHHTML${protectedBlocks.length}\uE001`;
    protectedBlocks.push(block);
    return token;
  });
  const stripped = protectedText.replace(MARKDOWN_FENCE_LINE_PATTERN, '');
  return stripped.replace(/\uE000RICHHTML(\d+)\uE001/g, (match, index) => (
    protectedBlocks[Number(index)] || ''
  ));
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
  '  var heightToken = __EASYCHAT2_HEIGHT_TOKEN__;',
  '  var nativeBridge = window.ReactNativeWebView;',
  '  var nativePostMessage = nativeBridge && nativeBridge.postMessage;',
  '  if (typeof nativePostMessage !== "function") return;',
  '  function send(payload){',
  '    try { nativePostMessage.call(nativeBridge, JSON.stringify(payload)); } catch (e) {}',
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
  '    send({ type: "height", value: h, token: heightToken });',
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
  '  }',
  '  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }',
  '})();',
  '</script>',
].join('\n');

function renderRichHtmlBridge(heightToken) {
  const token = JSON.stringify(String(heightToken || ''));
  return RICH_HTML_RESIZE_BRIDGE.replace('__EASYCHAT2_HEIGHT_TOKEN__', () => token);
}

export function buildRichHtmlCommandBridge(commandToken = '') {
  const token = JSON.stringify(String(commandToken || ''));
  return [
    '(function(){',
    `  var commandToken = ${token};`,
    '  var nativeBridge = window.ReactNativeWebView;',
    '  var nativePostMessage = nativeBridge && nativeBridge.postMessage;',
    '  if (typeof nativePostMessage !== "function") return;',
    '  var userGestureActive = false;',
    '  function markGesture(event){ if (event && event.isTrusted === false) return; userGestureActive = true; setTimeout(function(){ userGestureActive = false; }, 0); }',
    '  function sendCommand(value){',
    '    var text = String(value || "").trim();',
    '    if (!text || text.length > 500) return;',
    '    try { nativePostMessage.call(nativeBridge, JSON.stringify({ type: "command", value: text, gesture: true, token: commandToken })); } catch (e) {}',
    '  }',
    '  window.triggerSlash = function(command){',
    '    if (!userGestureActive) return;',
    '    var value = String(command || "");',
    '    if (value.indexOf("/send ") === 0) value = value.slice(7);',
    '    sendCommand(value);',
    '  };',
    '  document.addEventListener("pointerdown", markGesture, true);',
    '  document.addEventListener("keydown", markGesture, true);',
    '  document.addEventListener("click", function(ev){',
    '    if (!ev.isTrusted || !userGestureActive) return;',
    '    var el = ev.target;',
    '    while (el && el !== document.body) {',
    '      if (el.tagName === "BUTTON" && el.dataset && typeof el.dataset.command === "string" && el.dataset.command.trim()) {',
    '        sendCommand(el.dataset.command);',
    '        ev.preventDefault();',
    '        return;',
    '      }',
    '      el = el.parentElement;',
    '    }',
    '  }, true);',
    '})();',
  ].join('\n');
}

function buildRichHtmlLayoutStyle(resetMaxHeight = true) {
  const rules = [];
  if (resetMaxHeight) rules.push('body *{max-height:none !important;}');
  rules.push(
     '*,*::before,*::after{box-sizing:border-box!important;}',
     'html,body{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;min-height:100%!important;margin:0!important;padding:0!important;overflow-x:hidden!important;overflow-y:auto!important;}',
     'body{-webkit-overflow-scrolling:touch!important;}',
     'body,body *{overflow-wrap:anywhere!important;word-break:break-word!important;}',
     'main{max-width:100%!important;overflow-x:hidden!important;overflow-y:auto!important;}',
    'details{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;flex:0 0 100%!important;align-self:stretch!important;clear:both!important;}',
    'details>summary{display:flex!important;width:100%!important;max-width:100%!important;min-width:0!important;box-sizing:border-box!important;}',
    'details>div{width:100%!important;max-width:100%!important;min-width:0!important;box-sizing:border-box!important;}'
  );
  return rules.join('');
}

export function splitFullHtmlDocument(value) {
  const start = value.search(/<!doctype\s+html\b|<html[\s>]/i);
  if (start < 0) return null;
  const end = value.toLowerCase().lastIndexOf('</html>');
  if (end < start) return null;
  return {
    before: value.slice(0, start),
    document: value.slice(start, end + '</html>'.length),
    after: value.slice(end + '</html>'.length),
  };
}

// 视口型文档（100vh / position:fixed）的高度由 WebView 视口决定，
// 不能再用「先测内容再喂回高度」的闭环，否则会锁死在初始 1px。
const VIEWPORT_STYLE_PATTERN = /100(?:vh|dvh|svh|lvh)|position\s*:\s*fixed/i;
const VIEWPORT_META_PATTERN = /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i;

export function isViewportRichHtml(text) {
  const source = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, '');
  const blocks = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
  const inlineStyles = source.match(/<[a-z][^>]*\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi) || [];
  return [...blocks, ...inlineStyles].some(block => VIEWPORT_STYLE_PATTERN.test(block));
}

// 完整文档之外的正文要保留：包进 body，用 pre-wrap 维持换行。
function toPreambleHtml(text, position) {
  const value = String(text || '').trim();
  if (!value) return '';
  return `<div data-easychat2-preamble="${position}" style="white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${value}</div>`;
}

const FULL_DOCUMENT_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; base-uri \'none\'; form-action \'none\'; frame-src \'none\'; object-src \'none\'; connect-src \'none\'; img-src \'self\' data: blob: https:; media-src \'self\' data: blob: https:; font-src \'self\' data: https:; style-src \'unsafe-inline\' \'self\' data:; script-src \'unsafe-inline\' \'unsafe-eval\';">';
const FULL_DOCUMENT_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>';
function injectFullDocumentSupport(documentHtml, layoutStyle, heightToken = '', parts = null) {
  let output = documentHtml;
  const styleBlock = `<style data-easychat2-runtime="true">${layoutStyle}</style>`;
  const beforeHtml = toPreambleHtml(parts && parts.before, 'before');
  const afterHtml = toPreambleHtml(parts && parts.after, 'after');
  const viewportMeta = VIEWPORT_META_PATTERN.test(output) ? '' : FULL_DOCUMENT_VIEWPORT;
  if (/<head\b[^>]*>/i.test(output)) {
    output = output.replace(/(<head\b[^>]*>)/i, `$1${FULL_DOCUMENT_CSP}${viewportMeta}`);
  }
  if (/<\/head>/i.test(output)) {
    output = output.replace(/<\/head>/i, `${styleBlock}</head>`);
  } else if (/<head\b[^>]*>/i.test(output)) {
    output = output.replace(/(<head\b[^>]*>)/i, `$1${styleBlock}`);
  } else if (/<html\b[^>]*>/i.test(output)) {
    output = output.replace(/(<html\b[^>]*>)/i, `$1<head>${FULL_DOCUMENT_CSP}${viewportMeta}${styleBlock}</head>`);
  } else {
    return null;
  }
  if (/<body\b[^>]*>/i.test(output)) {
    output = output.replace(/(<body\b[^>]*>)/i, `$1${beforeHtml}`);
  } else if (beforeHtml) {
    output = output.replace(/(<html\b[^>]*>)/i, `$1<body>${beforeHtml}</body>`);
  }
  if (/<\/body>/i.test(output)) {
    output = output.replace(/<\/body>/i, `${afterHtml}${renderRichHtmlBridge(heightToken)}</body>`);
  } else {
    output += `${afterHtml}${renderRichHtmlBridge(heightToken)}`;
  }
  return output;
}

export function buildRichHtmlDocument({
  bodyHtml = '',
  textColor = '#e8e8f0',
  linkColor = '#6c63ff',
  fontSize = 15,
  fontFamily = '',
  heightToken = '',
} = {}) {
  const normalizedBody = stripMarkdownFences(bodyHtml).trim();
  const layoutStyle = buildRichHtmlLayoutStyle();
  const parts = splitFullHtmlDocument(normalizedBody);
  if (parts) {
    const supportedDocument = injectFullDocumentSupport(
      parts.document,
      buildRichHtmlLayoutStyle(false),
      heightToken,
      parts
    );
    if (supportedDocument) return supportedDocument;
  }
  const fontRule = fontFamily ? `font-family:${fontFamily};` : '';
  return (
    '<!DOCTYPE html><html><head>'
    + '<meta charset="utf-8"/>'
    + FULL_DOCUMENT_CSP
    + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>'
    + '<style>'
    + 'html,body{margin:0;padding:0;background:transparent;height:auto;}'
    + `body{color:${textColor};font-size:${fontSize}px;line-height:1.6;word-break:break-word;-webkit-text-size-adjust:100%;${fontRule}}`
    + 'img{max-width:100%!important;height:auto;}'
    + `a{color:${linkColor};}`
    + '*{box-sizing:border-box;}'
    + layoutStyle
    + '</style></head>'
    + `<body>${normalizedBody}${renderRichHtmlBridge(heightToken)}</body></html>`
  );
}
