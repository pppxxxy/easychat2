// 真实地图 HTML 构造测试：默认高德瓦片、{s} 子域、注入 API、自定义模板回落、
// 内联脚本注入转义（构造备份包即可注入 tileUrl）、页面文案由调用方传入、
// 以及 RealMapView 的接线（文案/导航白名单/读失败提示/保存失败归因）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_TILE_SUBDOMAINS,
  DEFAULT_TILE_URL,
  buildRealMapHtml,
  safeJson,
} from '../src/worldMap/realMapHtml.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(HERE, '..', 'src', name), 'utf8');

// 从 html 里抠出内联 <script> 的内容，用来断言「脚本里不会出现裸的结束标记」。
function inlineScript(html) {
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>');
  assert.ok(start >= 0 && end > start, '必须存在内联 script');
  return html.slice(start + '<script>'.length, end);
}

test('默认模板：含高德瓦片与全部占位符，暴露注入 API', () => {
  assert.ok(DEFAULT_TILE_URL.includes('autonavi'));
  assert.deepEqual(DEFAULT_TILE_SUBDOMAINS, ['1', '2', '3', '4']);

  const html = buildRealMapHtml();
  assert.ok(html.includes('autonavi'), '默认使用高德瓦片');
  assert.ok(html.includes('{x}') && html.includes('{y}') && html.includes('{z}') && html.includes('{s}'),
    '瓦片占位符齐全');
  assert.ok(html.includes('__setMarker') && html.includes('__setTile') && html.includes('__setView'),
    'RN 注入 API 齐全');
  assert.ok(html.includes('地图数据'), '署名保留');
});

test('自定义模板与子域以 JSON 注入', () => {
  const html = buildRealMapHtml({
    tileUrl: 'https://tile.example/{z}/{x}/{y}.png?s={s}',
    subdomains: ['a', 'b'],
  });
  assert.ok(html.includes('https://tile.example/{z}/{x}/{y}.png?s={s}'));
  assert.ok(html.includes('["a","b"]'), '子域数组序列化注入');
});

test('空白模板回落默认高德', () => {
  assert.ok(buildRealMapHtml({ tileUrl: '   ' }).includes('autonavi'));
  assert.ok(buildRealMapHtml({ subdomains: [] }).includes('autonavi'));
});

test('safeJson：转义会提前结束内联脚本的字符', () => {
  const out = safeJson({ tileUrl: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'), '不得留下裸的结束标记');
  assert.ok(!out.includes('<script>'), '不得留下裸的开始标记');
  assert.ok(out.includes('\\u003c/script\\u003e'), '</ 与 > 都转成 \\uXXXX');
  // JS 语义不变：转义后仍是同一个字符串值
  assert.deepEqual(JSON.parse(out), { tileUrl: '</script><script>alert(1)</script>' });
  // & 与 U+2028/U+2029 一并转义（后者在老引擎里是换行符，会让内联脚本语法错误）
  assert.equal(safeJson('a&b'), '"a\\u0026b"');
  assert.ok(!safeJson('a\u2028b\u2029c').includes('\u2028'));
  assert.ok(safeJson('a\u2028b').includes('\\u2028'));
  assert.equal(safeJson(undefined), 'null');
});

test('恶意 tileUrl 无法逃逸出内联 <script>（构造备份包即可注入的路径）', () => {
  const html = buildRealMapHtml({ tileUrl: '</script><script>window.__pwned=1</script>' });
  const script = inlineScript(html);
  assert.ok(!script.includes('</script>'), '脚本内容里不得出现结束标记');
  // 原始文本仍然作为「字符串数据」留在脚本里，但已转义成 \u003c，解析器不会再当成标签
  assert.ok(script.includes('\\u003cscript\\u003ewindow.__pwned=1\\u003c/script\\u003e'),
    '注入文本只能以转义形式存在');
  assert.ok(!script.includes('<script>'), '脚本里不得出现可被解析的开始标记');
  // 整份文档里，`</script>` 只允许出现在真正的收尾处（一次）
  assert.equal(html.split('</script>').length - 1, 1, '只应有一个 script 收尾标记');
  // 反证：不转义就会逃逸——这条锁住「必须用 safeJson」这个前提
  const unescaped = `var CONFIG = ${JSON.stringify({ tileUrl: '</script><script>x</script>' })};`;
  assert.ok(unescaped.includes('</script>'), 'JSON.stringify 本身不转义（这正是漏洞来源）');
});

test('页面文案由 strings 传入，缺省回落中文基准', () => {
  const html = buildRealMapHtml({
    strings: {
      attribution: 'Map data © Amap',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      recenter: 'Back to my location',
      hint: 'Drag to pan · pinch to zoom',
    },
  });
  assert.ok(html.includes('Map data © Amap'));
  assert.ok(html.includes('aria-label="Zoom in"') && html.includes('aria-label="Zoom out"'));
  assert.ok(html.includes('aria-label="Back to my location"'));
  assert.ok(html.includes('Drag to pan · pinch to zoom'));
  assert.ok(!html.includes('地图数据'), '传了英文就不该再留中文基准');
  // 只传一半：缺的回落基准，传了的生效
  const partial = buildRealMapHtml({ strings: { zoomIn: 'Zoom in' } });
  assert.ok(partial.includes('aria-label="Zoom in"'));
  assert.ok(partial.includes('地图数据 © 高德'));
  assert.ok(partial.includes('拖动平移 · 双指缩放'), 'hint 也有基准文案');
  // 空串 / 空白不算「传了」
  assert.ok(buildRealMapHtml({ strings: { attribution: '   ' } }).includes('地图数据 © 高德'));
});

test('strings 进的是 HTML 文本节点，按实体转义（不能形成标签）', () => {
  const html = buildRealMapHtml({
    strings: { attribution: '<img src=x onerror=alert(1)>', hint: 'a & b' },
  });
  assert.ok(!html.includes('<img src=x'), '文案里的标签必须被转义');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('a &amp; b'));
});

// ---- 接线断言（WebView 渲染在 Node 里跑不起来，只能查源码）----

test('RealMapView：页面文案经 t() 传入（4 个已有词条不再无人调用）+ 新增 hint', () => {
  const view = read('worldMap/RealMapView.js');
  for (const key of ['attribution', 'zoomIn', 'zoomOut', 'recenter', 'hint']) {
    assert.ok(view.includes(`t('world.map.real.html.${key}')`), `未接线 ${key}`);
  }
  assert.ok(/buildRealMapHtml\(\{[\s\S]*?strings:/.test(view), 'strings 必须传给 buildRealMapHtml');
});

test('RealMapView：WebView 只放行内联页自身，页面内导航一律拦下', () => {
  const view = read('worldMap/RealMapView.js');
  // 收紧最小必要集：'*' 等于对所有导航放行
  assert.ok(view.includes("originWhitelist={['about:blank', 'data:*']}"), 'originWhitelist 必须收紧');
  assert.ok(!view.includes("originWhitelist={['*']}"), "不得再写 originWhitelist={['*']}");
  assert.ok(view.includes('onShouldStartLoadWithRequest'), '必须有导航拦截回调');
  // about:blank 必须放行：iOS 的 loadHTMLString 用它当 baseURL，拦掉整页就不加载了
  assert.ok(view.includes("const ALLOWED_PAGE_PREFIXES = ['about:blank', 'data:text/html']"),
    '放行清单必须含 about:blank 与 data:text/html');
  assert.ok(view.includes('ALLOWED_PAGE_PREFIXES.some('), '回调必须用放行清单判断');
});

test('RealMapView：读失败与「真的没有位置」分开，且给可见提示与重试', () => {
  const view = read('worldMap/RealMapView.js');
  assert.ok(view.includes('const [loadFailed, setLoadFailed] = useState(false)'), '需要独立的读失败标记');
  assert.ok(view.includes('setLoadFailed(true)'), '读失败必须置标记');
  assert.ok(view.includes("t('world.map.real.loadFailed')"), '读失败要有可见文案');
  assert.ok(view.includes("t('common.retry')"), '读失败要能重试');
  // 不得再静默回落成「空清单 + seeded」（那正是「用户只看到还没有位置」的根因）
  assert.ok(!view.includes("places: [], activePlaceId: '', seeded: true, tileUrl: ''"),
    '不得再把读失败静默当成空清单');
});

test('RealMapView：保存失败按原因分文案，其余附真实原因并脱敏', () => {
  const view = read('worldMap/RealMapView.js');
  assert.ok(view.includes("from '../storage/secrets.js'") && view.includes('maskSecrets'), '真实原因必须脱敏');
  assert.ok(view.includes("t('world.map.real.saveFailed.corrupt')"), '已知原因（数据损坏）给专属文案');
  assert.ok(view.includes('CORRUPT_STORAGE_MARKER'), '按特征识别已知原因');
  // 两段式：其余情况 = 通用文案 + 换行 + 真实原因
  assert.ok(/const base = t\('world\.map\.real\.saveFailed'\);\s*\n\s*message = detail \? `\$\{base\}\\n\$\{detail\}` : base;/.test(view),
    '其余失败必须附上真实原因（照抄 useScreenWatchComments 的两段式）');
});
