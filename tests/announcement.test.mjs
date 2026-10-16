// 应用内公告（版本更新说明）的行为测试。
//
// 覆盖面：版本比对纯函数（相等/旧/新/带 v 前缀/非法 tag）、「不再提示」语义
//（标记后同版本不再弹、新版本会再弹）、release body 文本化（标题/列表/链接/空 body 兜底）、
// 以及 IO 层「拉取失败 → 用缓存 → 缓存也无 → 不弹不报错」。
// 纯函数直接 import；IO 层用内存 AsyncStorage + 注入 fetch（不联网）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  shouldAnnounce,
} from '../src/announcements/version.js';
import { markdownToPlainText, normalizeRelease } from '../src/announcements/release.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  // storage/io.js 会拉进 expo-file-system/legacy（大值兜底那条路）：公告用不到文件系统，
  // 换成空替身即可（不联网、不落文件，测的是 JSON 缓存与判定逻辑）。
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return {
      __esModule: true,
      documentDirectory: 'file:///documents/',
      getInfoAsync: async () => ({ exists: false }),
      writeAsStringAsync: async () => {},
      readAsStringAsync: async () => '',
      deleteAsync: async () => {},
    };
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request.endsWith('/diagnostics.js') || request.endsWith('/diagnostics')) {
    return { __esModule: true, recordDiagnostic: () => {} };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const announcements = loadModule(path.join(SRC_DIR, 'announcements', 'index.js'));
const {
  ANNOUNCEMENT_CACHE_KEY,
  loadReleaseOrCache,
  resolveAnnouncement,
  setDismissedVersion,
} = announcements;

// 假 fetch：responder 可以抛错（模拟断网/超时）。
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  impl.calls = calls;
  return impl;
}

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function releasePayload(tag = 'v2.10.1', extra = {}) {
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    body: '### 新功能\n- 修了搜索卡顿\n',
    html_url: `https://github.com/pppxxxy/easychat2/releases/tag/${tag}`,
    published_at: '2026-10-17T02:41:00Z',
    ...extra,
  };
}

test.beforeEach(() => { store.clear(); });

// ---- 版本比对 ---------------------------------------------------------

test('版本：parseVersion 容忍 v 前缀与非数字前缀，取不出返回 null', () => {
  assert.deepEqual(parseVersion('v2.10.1'), [2, 10, 1]);
  assert.deepEqual(parseVersion('2.10.1'), [2, 10, 1]);
  assert.deepEqual(parseVersion('release-2.10'), [2, 10]);
  assert.deepEqual(parseVersion('  v1.0  '), [1, 0]);
  for (const bad of ['', '   ', 'latest', null, undefined, {}]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} 应取不出`);
  }
});

test('版本：相等 / 旧 / 新 三态（含缺位补 0）', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0, '相同版本应为 0');
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0, 'v 前缀不参与比较');
  assert.equal(compareVersions('2.10', '2.10.0'), 0, '缺位按 0 补齐');
  assert.equal(compareVersions('2.11.0', '2.10.9'), 1, '2.11.0 应大于 2.10.9');
  assert.equal(compareVersions('2.9.0', '2.10.0'), -1, '2.9.0 应小于 2.10.0');
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1, '1.0.0 应小于 1.0.1');
  // 数字比较而非字符串比较：'2.10' > '2.9'（字符串比较会得出相反结论）
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1, '必须按数字段比较，不能按字符串');
});

test('版本：非法 tag 一律不算「有新版本」（不打扰用户）', () => {
  assert.equal(isNewerVersion('latest', '2.10.0'), false, '解析不出的 tag 不得算新版');
  assert.equal(isNewerVersion('', '2.10.0'), false, '空 tag 不得算新版');
  assert.equal(isNewerVersion(null, '2.10.0'), false, 'null tag 不得算新版');
  assert.equal(isNewerVersion('2.11.0', ''), false, '本地版本取不出时也不弹');
  assert.equal(isNewerVersion('v2.11.0', 'v2.10.0'), true);
  assert.equal(isNewerVersion('v2.10.0', 'v2.10.0'), false);
});

test('版本：compareVersions 对无法解析的一侧返回 0（而不是抛错）', () => {
  assert.equal(compareVersions('abc', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', null), 0);
});

// ---- 「不再提示」语义 --------------------------------------------------

test('公告判定：远端更新才弹；相等/更旧不弹', () => {
  const release = { version: '2.11.0' };
  assert.equal(shouldAnnounce(release, '2.10.0'), true);
  assert.equal(shouldAnnounce(release, '2.11.0'), false, '同版本不弹');
  assert.equal(shouldAnnounce({ version: '2.9.0' }, '2.10.0'), false, '更旧不弹');
  assert.equal(shouldAnnounce(null, '2.10.0'), false);
  assert.equal(shouldAnnounce({ version: '' }, '2.10.0'), false);
});

test('公告判定：「不再提示」标记后同版本不再弹', () => {
  const release = { version: '2.11.0' };
  assert.equal(shouldAnnounce(release, '2.10.0', ''), true);
  assert.equal(shouldAnnounce(release, '2.10.0', '2.11.0'), false, '已忽略该版本 → 不再弹');
});

test('公告判定：忽略旧版本后，发新版必须再弹（记的是版本号不是布尔）', () => {
  // 用户忽略了 2.11.0，然后发了 2.12.0：不能因为「忽略过一次」就永远闭嘴。
  assert.equal(shouldAnnounce({ version: '2.12.0' }, '2.10.0', '2.11.0'), true);
});

test('公告判定：忽略标记容忍 v 前缀形态差异（按版本号比，不比字面量）', () => {
  assert.equal(shouldAnnounce({ version: '2.11.0' }, '2.10.0', 'v2.11.0'), false);
  assert.equal(shouldAnnounce({ version: 'v2.11.0' }, '2.10.0', '2.11.0'), false);
});

// ---- release 归一与 body 文本化 ---------------------------------------

test('release：归一取出 tag/version/body/日期，v 前缀被剥离', () => {
  const release = normalizeRelease(releasePayload('v2.10.1'));
  assert.equal(release.tag, 'v2.10.1');
  assert.equal(release.version, '2.10.1');
  assert.equal(release.url, 'https://github.com/pppxxxy/easychat2/releases/tag/v2.10.1');
  assert.equal(release.publishedAt, '2026-10-17T02:41:00Z');
  assert.equal(normalizeRelease(null).tag, '');
  assert.equal(normalizeRelease({}).version, '');
});

test('release：归一必须**幂等**（缓存往返不得把 tag 弄丢 —— 修复过的实锤缺陷）', () => {
  // 原实现只认 GitHub 原始的 tag_name/published_at/html_url；而缓存里存的是归一后的
  // { tag, version, publishedAt, url }。读缓存再过一次归一 → tag 变空 → 公告凭空消失，
  // 表现是「断网启动明明有缓存却不弹」。这条断言把幂等钉住。
  const once = normalizeRelease(releasePayload('v2.10.1'));
  const twice = normalizeRelease(once);
  assert.deepEqual(twice, once, '归一化必须幂等：normalize(normalize(x)) === normalize(x)');
  assert.equal(twice.tag, 'v2.10.1', '缓存往返后 tag 不能丢');
  assert.equal(twice.version, '2.10.1');
  assert.equal(twice.publishedAt, '2026-10-17T02:41:00Z');
});

test('body 文本化：标题井号去掉、列表符统一成圆点、粗体符号去掉', () => {
  const text = markdownToPlainText('### 新功能\n- 修了搜索卡顿\n- **新增**红点\n\n正文一段。');
  assert.ok(!text.includes('#'), '标题井号必须去掉');
  assert.ok(text.includes('新功能'));
  assert.ok(text.includes('• 修了搜索卡顿'), '无序列表符统一成 •');
  assert.ok(text.includes('新增红点'), '粗体符号去掉但内容保留');
  assert.ok(!text.includes('**'), '不留粗体标记');
  assert.ok(text.includes('正文一段。'));
});

test('body 文本化：链接降级成「文字 (URL)」纯文本，不产出可点击结构', () => {
  const text = markdownToPlainText('见 [更新说明](https://example.test/notes) 一节');
  assert.ok(text.includes('更新说明 (https://example.test/notes)'), `实际: ${text}`);
});

test('body 文本化：行内代码去反引号、引用符去掉、连续空行压缩', () => {
  const text = markdownToPlainText('运行 `npm test`\n\n\n\n> 注意看日志');
  assert.ok(text.includes('运行 npm test'));
  assert.ok(!text.includes('`'), '反引号去掉');
  assert.ok(text.includes('注意看日志'));
  assert.ok(!text.includes('>'), '引用符去掉');
  assert.ok(!text.includes('\n\n\n'), '连续空行压缩');
});

test('body 文本化：非字符串一律当空（不得渲染出 [object Object]）', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}, [], true]) {
    assert.equal(markdownToPlainText(bad), '', `${JSON.stringify(bad)} 应返回空串`);
  }
  assert.equal(markdownToPlainText('正常').length > 0, true);
});

// ---- IO 层：拉取 / 缓存 / 静默 ----------------------------------------

test('IO：拉到 release 后写缓存，后续可从缓存读回', async () => {
  const fetchImpl = fakeFetch(async () => okResponse(releasePayload('v3.0.0')));
  const result = await loadReleaseOrCache({ fetchImpl });
  assert.equal(result.fromCache, false);
  assert.equal(result.release.version, '3.0.0');
  assert.ok(store.has(ANNOUNCEMENT_CACHE_KEY), '必须落缓存，供断网启动使用');

  const cached = await loadReleaseOrCache({ fetchImpl: fakeFetch(async () => { throw new Error('offline'); }) });
  assert.equal(cached.fromCache, true);
  assert.equal(cached.release.version, '3.0.0', '断网启动必须能用缓存');
});

test('IO：拉取失败且无缓存 → 返回 null 且**不抛错**（公告不可用不能打扰用户）', async () => {
  const fetchImpl = fakeFetch(async () => { throw new Error('offline'); });
  const result = await loadReleaseOrCache({ fetchImpl });
  assert.equal(result.release, null);
  assert.equal(result.fromCache, true); // 标记为「未从网络拿到」
});

test('IO：HTTP 失败（限流/5xx）同样静默回落缓存', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: false,
    status: 403,
    headers: { get: name => (name === 'x-ratelimit-remaining' ? '0' : null) },
    json: async () => ({ message: 'rate limited' }),
    text: async () => 'rate limited',
  }));
  const result = await loadReleaseOrCache({ fetchImpl });
  assert.equal(result.release, null);
});

test('IO：payload 缺 tag_name 时视为无效，不当成有效 release', async () => {
  const fetchImpl = fakeFetch(async () => okResponse({ name: 'no tag', body: 'x' }));
  const result = await loadReleaseOrCache({ fetchImpl });
  assert.equal(result.release, null, '没有 tag 的载荷不能当公告');
});

test('IO：resolveAnnouncement 组合「拉取 + 比对 + 忽略」三个条件', async () => {
  const fetchImpl = fakeFetch(async () => okResponse(releasePayload('v2.11.0')));

  // ① 本地更旧 → 弹
  const newer = await resolveAnnouncement({ fetchImpl, localVersion: '2.10.0' });
  assert.equal(newer.shouldShow, true);
  assert.equal(newer.release.version, '2.11.0');

  // ② 本地同版本 → 不弹
  const same = await resolveAnnouncement({ fetchImpl, localVersion: '2.11.0' });
  assert.equal(same.shouldShow, false);

  // ③ 用户点过「不再提示此版本」→ 不弹
  await setDismissedVersion('2.11.0');
  const dismissed = await resolveAnnouncement({ fetchImpl, localVersion: '2.10.0' });
  assert.equal(dismissed.shouldShow, false, '已忽略的版本必须不再打扰');
  assert.ok(dismissed.release, '但数据仍要带出来，设置页入口还能看');
});

test('IO：忽略某版本后本地出更新版本仍会弹（跨版本不误伤）', async () => {
  await setDismissedVersion('2.11.0');
  const fetchImpl = fakeFetch(async () => okResponse(releasePayload('v2.12.0')));
  const result = await resolveAnnouncement({ fetchImpl, localVersion: '2.10.0' });
  assert.equal(result.shouldShow, true, '忽略 2.11.0 不该让 2.12.0 也闭嘴');
});

test('IO：本地版本取不出（空串）时一律不弹，不报错', async () => {
  const fetchImpl = fakeFetch(async () => okResponse(releasePayload('v9.9.9')));
  const result = await resolveAnnouncement({ fetchImpl, localVersion: '' });
  assert.equal(result.shouldShow, false);
});

test('IO：只发 GitHub 公共 API，不带 token/用户数据（安全）', async () => {
  const fetchImpl = fakeFetch(async () => okResponse(releasePayload('v2.11.0')));
  await loadReleaseOrCache({ fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, '只发一个请求');
  const [{ url, options }] = fetchImpl.calls;
  assert.ok(url.startsWith('https://api.github.com/repos/pppxxxy/easychat2/releases/latest'), url);
  const headers = (options && options.headers) || {};
  assert.ok(!('Authorization' in headers), '不得携带 token —— 公告是匿名公共读取');
  assert.ok(!JSON.stringify(options || {}).includes('easychat2_'), '不得上行任何本地存储键/用户数据');
});
