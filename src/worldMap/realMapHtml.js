// 真实地图的内联 HTML（自绘 slippy map，无外部 CDN 依赖）：
// 按 Web Mercator 计算视口内瓦片，用绝对定位 <img> 拼贴；单指拖动/双指缩放/按钮缩放。
// 默认高德栅格瓦片（GCJ-02）。RN 通过 injectJavaScript 调 __setTile/__setMarkers/__setView，
// 用户点图时用 postMessage 把 GCJ-02 坐标回传给 RN（标点功能）。
// 纯字符串构造，便于断言默认模板与注入 API。

export const DEFAULT_TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
export const DEFAULT_TILE_SUBDOMAINS = ['1', '2', '3', '4'];

export function buildRealMapHtml({ tileUrl = DEFAULT_TILE_URL, subdomains = DEFAULT_TILE_SUBDOMAINS } = {}) {
  const template = String(tileUrl || '').trim() || DEFAULT_TILE_URL;
  const subs = Array.isArray(subdomains) && subdomains.length
    ? subdomains.map(String)
    : DEFAULT_TILE_SUBDOMAINS;
  const config = JSON.stringify({ tileUrl: template, subdomains: subs });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1a1a2e;}
  #map{position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;touch-action:none;}
  #map img.tile{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none;pointer-events:none;background:#242438;}
  #markers{position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;}
  #markers .mk{position:absolute;width:14px;height:14px;margin-left:-7px;margin-top:-7px;border-radius:50%;background:#6c63ff;border:3px solid #ffffff;box-shadow:0 0 0 3px rgba(108,99,255,.35);}
  #markers .mk.current{background:#4caf50;box-shadow:0 0 0 3px rgba(76,175,80,.35);}
  #markers .mk.active{width:18px;height:18px;margin-left:-9px;margin-top:-9px;background:#ffb300;border-color:#ffffff;box-shadow:0 0 0 5px rgba(255,179,0,.45);}
  #map.marking{cursor:crosshair;}
  #map.marking::after{content:'';position:absolute;top:0;right:0;bottom:0;left:0;border:2px dashed #6c63ff;box-sizing:border-box;pointer-events:none;}
  #attrib{position:absolute;right:6px;bottom:6px;font-size:10px;color:#aaa;background:rgba(26,26,46,.65);padding:2px 6px;border-radius:6px;}
  #hint{position:absolute;left:8px;bottom:6px;font-size:10px;color:#aaa;}
  #controls{position:absolute;right:10px;bottom:34px;display:flex;flex-direction:column;}
  #controls button{width:38px;height:38px;margin-top:8px;border:none;border-radius:19px;background:#2d2d44;color:#ffffff;font-size:20px;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.4);}
  #controls button:active{background:#3a3a5a;}
</style>
</head>
<body>
<div id="map"></div>
<div id="markers"></div>
<div id="attrib">地图数据 © 高德</div>
<div id="hint">拖动平移 · 双指缩放</div>
<div id="controls">
  <button id="zi" aria-label="放大">+</button>
  <button id="zo" aria-label="缩小">−</button>
  <button id="rc" aria-label="回到我的位置">◎</button>
</div>
<script>
(function(){
  var CONFIG = ${config};
  var TILE = CONFIG.tileUrl;
  var SUBS = CONFIG.subdomains;
  var SIZE = 256;
  var MIN_Z = 3;
  var MAX_Z = 18;
  var LAT_LIMIT = 85.05112878;
  var mapEl = document.getElementById('map');
  var markersEl = document.getElementById('markers');
  var view = { lat: 39.9042, lng: 116.4074, z: 14 };
  // 标注列表：[{ lat, lng, kind }]，kind='current' 是 GPS 当前位置，其余是用户标注点。
  // 用 DOM 复用（按索引更新已有节点）避免每帧重建。
  // 标点模式开关：RN 上按「标点」按钮时置 true，取到点后置回 false。
  var marking = false;
  var markers = [];
  var W = 0, H = 0;
  var tiles = {};

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lngToX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z) * SIZE; }
  function latToY(lat, z) {
    var s = Math.sin(clamp(lat, -LAT_LIMIT, LAT_LIMIT) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * SIZE;
  }
  function xToLng(x, z) { return x / (Math.pow(2, z) * SIZE) * 360 - 180; }
  function yToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (Math.pow(2, z) * SIZE);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function applyTile(x, y, z) {
    return TILE
      .replace('{x}', x)
      .replace('{y}', y)
      .replace('{z}', z)
      .replace('{s}', SUBS[(x + y) % SUBS.length]);
  }

  function render() {
    if (W <= 0 || H <= 0) return;
    var z = view.z;
    var n = Math.pow(2, z);
    var cx = lngToX(view.lng, z);
    var cy = latToY(view.lat, z);
    var startX = Math.floor((cx - W / 2) / SIZE);
    var endX = Math.floor((cx + W / 2) / SIZE);
    var startY = Math.floor((cy - H / 2) / SIZE);
    var endY = Math.floor((cy + H / 2) / SIZE);
    var needed = {};
    for (var tx = startX; tx <= endX; tx++) {
      for (var ty = startY; ty <= endY; ty++) {
        if (ty < 0 || ty >= n) continue;
        var wx = ((tx % n) + n) % n;
        var key = z + '/' + wx + '/' + ty;
        needed[key] = true;
        var img = tiles[key];
        if (!img) {
          img = document.createElement('img');
          img.className = 'tile';
          img.src = applyTile(wx, ty, z);
          mapEl.appendChild(img);
          tiles[key] = img;
        }
        img.style.left = (tx * SIZE - cx + W / 2) + 'px';
        img.style.top = (ty * SIZE - cy + H / 2) + 'px';
      }
    }
    Object.keys(tiles).forEach(function(key) {
      if (!needed[key]) {
        var el = tiles[key];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete tiles[key];
      }
    });
    // 标注：按索引复用已有节点，多余节点移除。
    for (var i = 0; i < markers.length; i++) {
      var item = markers[i];
      var node = markersEl.children[i];
      if (!node) {
        node = document.createElement('div');
        markersEl.appendChild(node);
      }
      node.className = 'mk' + (item.kind === 'current' ? ' current' : '') + (item.active ? ' active' : '');
      node.style.left = (lngToX(item.lng, z) - cx + W / 2) + 'px';
      node.style.top = (latToY(item.lat, z) - cy + H / 2) + 'px';
    }
    while (markersEl.children.length > markers.length) {
      markersEl.removeChild(markersEl.lastChild);
    }
  }

  function setZoom(z) {
    var nz = clamp(Math.round(z), MIN_Z, MAX_Z);
    if (nz === view.z) return;
    view.z = nz;
    render();
  }

  // 标点模式：点一下把该点换算成经纬度回传 RN（不在此处落点，等 RN 确认）。
  function emitTap(clientX, clientY) {
    if (!marking) return;
    var z = view.z;
    var lng = xToLng(lngToX(view.lng, z) + (clientX - W / 2), z);
    var lat = yToLat(latToY(view.lat, z) + (clientY - H / 2), z);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'map-tap', lat: lat, lng: lng }));
    }
  }

  var downX = 0, downY = 0, lastX = 0, lastY = 0;
  function onDown(x, y) { dragging = true; downX = x; downY = y; lastX = x; lastY = y; }
  function onMove(x, y) {
    if (!dragging) return;
    var dx = x - lastX, dy = y - lastY;
    lastX = x; lastY = y;
    var z = view.z;
    view.lng = xToLng(lngToX(view.lng, z) - dx, z);
    view.lat = clamp(yToLat(latToY(view.lat, z) - dy, z), -LAT_LIMIT, LAT_LIMIT);
    render();
  }
  function onUp(x, y) {
    if (!dragging) return;
    dragging = false;
    // 位移很小才当点按：拖图后松手不能顺手落一个点。
    if (x === undefined || y === undefined) return;
    if (Math.abs(x - downX) <= 8 && Math.abs(y - downY) <= 8) emitTap(x, y);
  }

  mapEl.addEventListener('mousedown', function(e) { onDown(e.clientX, e.clientY); });
  window.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', function(e) { onUp(e.clientX, e.clientY); });

  var pinchDist = 0, multiTouch = false;
  mapEl.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      multiTouch = false;
      onDown(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      // 双指缩放期间不算点按，避免缩放手势结束顺手落点。
      multiTouch = true;
      pinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });
  mapEl.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      var d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (pinchDist > 0) {
        if (d / pinchDist > 1.3) { setZoom(view.z + 1); pinchDist = d; }
        else if (d / pinchDist < 0.77) { setZoom(view.z - 1); pinchDist = d; }
      }
    }
    e.preventDefault();
  }, { passive: false });
  mapEl.addEventListener('touchend', function(e) {
    if (multiTouch) { multiTouch = false; dragging = false; return; }
    var t = (e.changedTouches && e.changedTouches[0]) || null;
    onUp(t ? t.clientX : undefined, t ? t.clientY : undefined);
  }, { passive: true });

  document.getElementById('zi').onclick = function() { setZoom(view.z + 1); };
  document.getElementById('zo').onclick = function() { setZoom(view.z - 1); };
  document.getElementById('rc').onclick = function() {
    var first = markers[0];
    if (first) { view.lat = first.lat; view.lng = first.lng; render(); }
  };

  window.__setView = function(lat, lng, z) {
    if (isFinite(lat)) view.lat = lat;
    if (isFinite(lng)) view.lng = lng;
    if (isFinite(z)) view.z = clamp(Math.round(z), MIN_Z, MAX_Z);
    render();
  };
  // 同步全部标注点并定位到第一个（通常是 GPS 当前位置或刚选中的标注点）。
  window.__setMarkers = function(list) {
    markers = Array.isArray(list) ? list : [];
    var first = markers[0];
    if (first && isFinite(first.lat) && isFinite(first.lng)) {
      view.lat = first.lat;
      view.lng = first.lng;
    }
    render();
  };
  window.__setMarking = function(on) {
    marking = on === true;
    if (marking) mapEl.className = 'marking';
    else mapEl.className = '';
  };
  window.__setTile = function(url, subs) {
    if (url) TILE = url;
    if (subs && subs.length) SUBS = subs;
    Object.keys(tiles).forEach(function(key) {
      var el = tiles[key];
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    tiles = {};
    render();
  };

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    render();
  }
  window.addEventListener('resize', resize);
  resize();
})();
</script>
</body>
</html>`;
}
