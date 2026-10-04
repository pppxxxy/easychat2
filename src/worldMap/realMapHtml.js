// 真实地图的内联 HTML（自绘 slippy map，无外部 CDN 依赖）：
// 按 Web Mercator 计算视口内瓦片，用绝对定位 <img> 拼贴；单指拖动/双指缩放/按钮缩放。
// 默认高德栅格瓦片（GCJ-02）。RN 通过 injectJavaScript 调 __setTile/__setMarker/__setView。
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
  #marker{position:absolute;width:16px;height:16px;margin-left:-8px;margin-top:-8px;border-radius:50%;background:#6c63ff;border:3px solid #ffffff;box-shadow:0 0 0 4px rgba(108,99,255,.35);pointer-events:none;display:none;}
  #attrib{position:absolute;right:6px;bottom:6px;font-size:10px;color:#aaa;background:rgba(26,26,46,.65);padding:2px 6px;border-radius:6px;}
  #hint{position:absolute;left:8px;bottom:6px;font-size:10px;color:#aaa;}
  #controls{position:absolute;right:10px;bottom:34px;display:flex;flex-direction:column;}
  #controls button{width:38px;height:38px;margin-top:8px;border:none;border-radius:19px;background:#2d2d44;color:#ffffff;font-size:20px;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.4);}
  #controls button:active{background:#3a3a5a;}
</style>
</head>
<body>
<div id="map"></div>
<div id="marker"></div>
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
  var markerEl = document.getElementById('marker');
  var view = { lat: 39.9042, lng: 116.4074, z: 14 };
  var marker = null;
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
    if (marker) {
      markerEl.style.left = (lngToX(marker.lng, z) - cx + W / 2) + 'px';
      markerEl.style.top = (latToY(marker.lat, z) - cy + H / 2) + 'px';
      markerEl.style.display = 'block';
    } else {
      markerEl.style.display = 'none';
    }
  }

  function setZoom(z) {
    var nz = clamp(Math.round(z), MIN_Z, MAX_Z);
    if (nz === view.z) return;
    view.z = nz;
    render();
  }

  var dragging = false, lastX = 0, lastY = 0;
  function onDown(x, y) { dragging = true; lastX = x; lastY = y; }
  function onMove(x, y) {
    if (!dragging) return;
    var dx = x - lastX, dy = y - lastY;
    lastX = x; lastY = y;
    var z = view.z;
    view.lng = xToLng(lngToX(view.lng, z) - dx, z);
    view.lat = clamp(yToLat(latToY(view.lat, z) - dy, z), -LAT_LIMIT, LAT_LIMIT);
    render();
  }
  function onUp() { dragging = false; }

  mapEl.addEventListener('mousedown', function(e) { onDown(e.clientX, e.clientY); });
  window.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', onUp);

  var pinchDist = 0;
  mapEl.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
    else if (e.touches.length === 2) {
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
  mapEl.addEventListener('touchend', onUp, { passive: true });

  document.getElementById('zi').onclick = function() { setZoom(view.z + 1); };
  document.getElementById('zo').onclick = function() { setZoom(view.z - 1); };
  document.getElementById('rc').onclick = function() {
    if (marker) { view.lat = marker.lat; view.lng = marker.lng; render(); }
  };

  window.__setView = function(lat, lng, z) {
    if (isFinite(lat)) view.lat = lat;
    if (isFinite(lng)) view.lng = lng;
    if (isFinite(z)) view.z = clamp(Math.round(z), MIN_Z, MAX_Z);
    render();
  };
  window.__setMarker = function(lat, lng) {
    if (isFinite(lat) && isFinite(lng)) {
      marker = { lat: lat, lng: lng };
      view.lat = lat;
      view.lng = lng;
    }
    render();
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
