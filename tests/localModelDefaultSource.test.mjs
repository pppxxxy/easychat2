// 本地模型「默认下载源」与「失败留痕」两条不变量。
//
// 事故（用户 2026-10-19 真机反馈）：
//   「设置界面 → 本地模型的下载。hf-mirror.com 我从镜像站怎么搜不到模型？
//     啥都搜不到，我对准正确模型的名字去搜都搜不到。」
// 实测三条（本机实跑 App 的真实代码路径 searchModels()）：
//   · hf-mirror.com  → 每个关键词都返回 30 条（qwen / llama / gemma / 精确模型名全中）
//   · huggingface.co → 全部 `fetch failed`（国内直连不通）
//   · 而 emptyDownloadDraft() 的 sourceId 是 ''，两处都写 `|| 'huggingface'`
//     ⇒ 默认落在**连不上的那个源**上 ⇒ 「啥都搜不到」。
//
// 所以这不是网络问题，是默认值选错了。另外失败路径此前**完全没有诊断留痕**，
// 用户日志里一条相关记录都没有——「没有记录」不等于「没有失败」。
//
// 本轮（T1-T6）补充：
//   T1 精选目录也有自己的一份 'huggingface' 默认值（featured.js），纳入单一事实源。
//   T2 底层三处兜底（provider / baseUrl / downloadUrl）对空源仍回落官方站 —— 这才是
//      「空源 = 官方站」的**最后一条入口**：手动输入 URL、selection.sourceId 为空时
//      会绕过界面默认值直接打官方站。全部归一。
//   T3/T4 测试去脆弱 + 留痕改运行时断言（见下）。
//   T5 消除 noteCatalogFailure 里的变量遮蔽。
//   T6 弹窗 effect 用旧闭包 sourceId 发请求（UI 选中源与请求源可能不一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_LOCAL_MODEL_SOURCE_ID,
  LOCAL_MODEL_DOWNLOAD_SOURCES,
  resolveLocalModelSourceId,
} from '../src/localModel/modelState.js';
import {
  buildDownloadUrl,
  catalogProviderForSource,
  parseHuggingFaceSearch,
  searchModels,
  listModelFiles,
} from '../src/localModel/modelCatalog.js';
import { selectFeaturedModels } from '../src/localModel/featured.js';

const SRC = path.resolve('src');

test('默认源必须是镜像，不能是官方站（国内直连必失败）', () => {
  assert.equal(DEFAULT_LOCAL_MODEL_SOURCE_ID, 'hf-mirror');
  assert.notEqual(
    DEFAULT_LOCAL_MODEL_SOURCE_ID,
    'huggingface',
    '默认回落官方站会让国内用户的第一印象是「功能坏了」'
  );
  // 默认值必须真的在下载源列表里，否则界面选择器上不会有它（选了也不显示）。
  assert.ok(
    LOCAL_MODEL_DOWNLOAD_SOURCES.some(item => item.id === DEFAULT_LOCAL_MODEL_SOURCE_ID),
    '默认源必须在 LOCAL_MODEL_DOWNLOAD_SOURCES 里'
  );
});

test('resolveLocalModelSourceId：空/未知一律回落到镜像，合法值原样保留', () => {
  assert.equal(resolveLocalModelSourceId(''), DEFAULT_LOCAL_MODEL_SOURCE_ID);
  assert.equal(resolveLocalModelSourceId(undefined), DEFAULT_LOCAL_MODEL_SOURCE_ID);
  assert.equal(resolveLocalModelSourceId(null), DEFAULT_LOCAL_MODEL_SOURCE_ID);
  assert.equal(resolveLocalModelSourceId('   '), DEFAULT_LOCAL_MODEL_SOURCE_ID);
  // 未知 id（历史数据/拼错）也必须回落，而不是把脏值传下去导致请求打到别处。
  assert.equal(resolveLocalModelSourceId('no-such-source'), DEFAULT_LOCAL_MODEL_SOURCE_ID);
  // 合法值不被改写：用户显式选的官方站/魔搭必须尊重。
  assert.equal(resolveLocalModelSourceId('huggingface'), 'huggingface');
  assert.equal(resolveLocalModelSourceId('modelscope'), 'modelscope');
  assert.equal(resolveLocalModelSourceId('hf-mirror'), 'hf-mirror');
});

test('镜像复用 HuggingFace 的搜索接口（数据同源，只是主机不同）', () => {
  assert.equal(catalogProviderForSource('hf-mirror'), 'huggingface');
  assert.equal(catalogProviderForSource('huggingface'), 'huggingface');
  assert.equal(catalogProviderForSource('modelscope'), 'modelscope');
});

// T3：接线用例去脆弱。
// 旧写法用 /\|\|\s*'huggingface'/ 扫源码——注释里出现 `|| 'huggingface'` 会误报
// （本轮就真的踩到了：解释事故的注释里正含这个片段），而且它只证明「某字符串消失」，
// 不证明「确实调用了归一函数」。
// 新写法两步：① 先剥离注释，再判回归串；② 直接断言**调用点**出现了归一函数。
function stripComments(source) {
  // 先剥块注释再剥行注释，避免把块注释里的 // 当成行注释起点。
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('接线：弹窗与面板的调用点确实经归一函数解析源（不靠扫字符串）', () => {
  const modalPath = path.join(SRC, 'localModel', 'ModelSearchModal.js');
  const panelPath = path.join(SRC, 'LocalModelPanel.js');
  const modalCode = stripComments(fs.readFileSync(modalPath, 'utf8'));
  const panelCode = stripComments(fs.readFileSync(panelPath, 'utf8'));

  // ① 剥离注释后，代码里不得再有 `|| 'huggingface'` 这种回落。
  assert.equal(
    /\|\|\s*'huggingface'/.test(modalCode),
    false,
    '弹窗代码（去掉注释后）不得再用 || huggingface 回落'
  );
  assert.equal(
    /\|\|\s*'huggingface'/.test(panelCode),
    false,
    '面板代码（去掉注释后）不得再用 || huggingface 回落'
  );
  // 反证：保留注释的原文**确实**含有该片段（否则上面两条断言是空转，测不出东西）。
  const modalRaw = fs.readFileSync(modalPath, 'utf8');
  assert.ok(
    /\|\|\s*'huggingface'/.test(modalRaw) || modalRaw.includes("'huggingface'"),
    '前提：这个文件里本来就提到过 huggingface（注释），所以剥离注释这一步是必要的'
  );

  // ② 关键：**至少有一个归一入口**，而不是只把字面量删掉。
  // 归一的落点是弹窗（它同时管 UI 选中态与请求），面板只负责把草稿原样传下去——
  // 要求面板也调用归一函数是**过度规定**（第一版就是这么写错的）：归一集中在一处
  // 比分散在两处更难漂移。
  assert.ok(
    /resolveLocalModelSourceId\(/.test(modalCode),
    '弹窗必须实际调用 resolveLocalModelSourceId（删掉字面量不等于接上归一）'
  );
  assert.ok(
    /initialSourceId=\{acquire\.downloadDraft\.sourceId[^}]*\}/.test(panelCode),
    '面板必须把草稿源原样传给弹窗（不自己加回落值；归一由弹窗统一做）'
  );
});

test('T3 反证：把归一调用删掉，上面的断言会失败（证明它测的是调用而非字面量）', () => {
  // 用一份「删掉归一调用、但注释里仍提到 huggingface」的模拟源码验证判据有效性。
  const fake = stripComments(`
    // 注释里提到 || 'huggingface' 是允许的
    const [sourceId, setSourceId] = useState(initialSourceId || 'huggingface');
  `);
  assert.equal(
    /resolveLocalModelSourceId\(/.test(fake),
    false,
    '没有归一调用时判据必须为假'
  );
  assert.equal(
    /\|\|\s*'huggingface'/.test(fake),
    true,
    '剥离注释后仍应抓到真正的回落代码（注释本身已被剥掉）'
  );
});

test('T4：失败留痕走**运行时**断言（注入 spy，看真的被调用）', async () => {
  const calls = [];
  const spy = (kind, error, context) => calls.push({ kind, error, context });
  const failing = async () => { throw new Error('fetch failed'); };

  // 搜索失败：必须调用一次留痕。
  await assert.rejects(
    () => searchModels('hf-mirror', 'qwen', { fetchImpl: failing, recordFailure: spy }),
    /fetch failed/
  );
  assert.equal(calls.length, 1, '搜索失败必须恰好留痕一次');
  assert.equal(calls[0].kind, 'api');
  assert.match(String(calls[0].context), /source=hf-mirror/, '留痕要带上源（否则无从判断是哪个源挂了）');
  assert.match(String(calls[0].context), /fetch failed/, '留痕要带上原因首行');
  // 隐私：诊断里绝不能出现用户搜的词。
  assert.equal(
    /qwen/.test(String(calls[0].context)) || /qwen/.test(String(calls[0].error && calls[0].error.message)),
    false,
    '诊断不得包含 query 全文（可能是私人内容）'
  );

  // 取文件失败：同样要留痕，且阶段名不同（便于区分是搜索还是文件层挂了）。
  calls.length = 0;
  await assert.rejects(
    () => listModelFiles('hf-mirror', 'Qwen/Qwen3-0.6B-GGUF', { fetchImpl: failing, recordFailure: spy }),
    /fetch failed/
  );
  assert.equal(calls.length, 1, '取文件失败必须恰好留痕一次');
  assert.match(String(calls[0].error.message), /files/, '阶段名要能区分 search / files');
});

test('T4：留痕自身抛错不得挡住主流程（留痕是尽力而为）', async () => {
  const failing = async () => { throw new Error('fetch failed'); };
  const throwingSpy = () => { throw new Error('diagnostics exploded'); };
  await assert.rejects(
    () => searchModels('hf-mirror', 'qwen', { fetchImpl: failing, recordFailure: throwingSpy }),
    /fetch failed/,
    '留痕炸了也要把**原始错误**抛出去，不能被它顶掉'
  );
});

test('失败留痕：错误必须原样抛给调用方（留痕不能把错误顶掉）', async () => {
  const failing = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => searchModels('hf-mirror', 'qwen', { fetchImpl: failing }),
    /fetch failed/
  );
});

test('解析健壮性：tags 大小写混用（GGUF）也必须认', () => {
  const json = [
    { modelId: 'a/Upper-GGUF', tags: ['GGUF'], downloads: 1, likes: 0 },
    { modelId: 'b/lower-gguf', tags: ['gguf'], downloads: 1, likes: 0 },
    { modelId: 'c/not-gguf', tags: ['safetensors'], downloads: 1, likes: 0 },
    { modelId: '', tags: ['gguf'] },
  ];
  const out = parseHuggingFaceSearch(json);
  assert.deepEqual(out.map(item => item.repoId), ['a/Upper-GGUF', 'b/lower-gguf']);
});

test('对照：注入了成功 fetchImpl 时能正常返回并带上 sourceId', async () => {
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { modelId: 'Qwen/Qwen3-0.6B-GGUF', tags: ['gguf'], downloads: 100, likes: 5 },
    ],
  });
  const list = await searchModels('hf-mirror', 'qwen', { fetchImpl: okFetch });
  assert.equal(list.length, 1);
  assert.equal(list[0].repoId, 'Qwen/Qwen3-0.6B-GGUF');
  assert.equal(list[0].sourceId, 'hf-mirror', '结果要带上实际用的源，回填草稿时不能丢');
});

// ── T1：精选目录的默认源纳入单一事实源 ──────────────────────────────────────

test('T1：selectFeaturedModels 不传源时用默认源（此前硬编码 huggingface）', () => {
  const list = selectFeaturedModels();
  assert.ok(list.length > 0, '前提：精选目录非空');
  for (const item of list) {
    assert.equal(
      item.sourceId,
      DEFAULT_LOCAL_MODEL_SOURCE_ID,
      '精选条目必须带默认源，不能各自硬编码 huggingface'
    );
  }
});

test('T1：显式传合法源时原样保留（不夺用户的选择）', () => {
  for (const sourceId of ['huggingface', 'modelscope', 'hf-mirror']) {
    const list = selectFeaturedModels({ sourceId });
    assert.ok(list.every(item => item.sourceId === sourceId), `显式 ${sourceId} 必须原样保留`);
  }
});

test('T1：传空/未知源时归一到默认源（不是官方站）', () => {
  for (const sourceId of ['', null, undefined, 'no-such-source']) {
    const list = selectFeaturedModels({ sourceId });
    assert.ok(
      list.every(item => item.sourceId === DEFAULT_LOCAL_MODEL_SOURCE_ID),
      `空/未知源（${String(sourceId)}）必须归一到默认源`
    );
  }
});

// ── T2：底层兜底统一指向默认源 ─────────────────────────────────────────────

test('T2：catalogProviderForSource 对空/未知源按默认源解释', () => {
  const defaultProvider = catalogProviderForSource(DEFAULT_LOCAL_MODEL_SOURCE_ID);
  for (const sourceId of ['', null, undefined, 'no-such-source']) {
    assert.equal(
      catalogProviderForSource(sourceId),
      defaultProvider,
      `空/未知源（${String(sourceId)}）必须按默认源解释，而不是字面量 huggingface`
    );
  }
  // 合法源仍走各自 provider。
  assert.equal(catalogProviderForSource('modelscope'), 'modelscope');
  assert.equal(catalogProviderForSource('hf-mirror'), 'huggingface');
});

test('T2：buildDownloadUrl 对空/未知源不再生成官方站主机', () => {
  const good = buildDownloadUrl(DEFAULT_LOCAL_MODEL_SOURCE_ID, 'Qwen/Qwen3-0.6B-GGUF', 'main', 'a.gguf');
  assert.ok(good.length > 0);
  for (const sourceId of ['', null, undefined, 'no-such-source']) {
    const url = buildDownloadUrl(sourceId, 'Qwen/Qwen3-0.6B-GGUF', 'main', 'a.gguf');
    assert.equal(
      url,
      good,
      `空/未知源（${String(sourceId)}）必须与默认源生成**完全相同**的地址（含主机与路径前缀）`
    );
    assert.equal(
      /^https:\/\/huggingface\.co\//.test(url),
      false,
      `空/未知源不得生成官方站地址，实际：${url}`
    );
  }
  // 合法源仍走自己的主机（魔搭多一层 /models）。
  const ms = buildDownloadUrl('modelscope', 'Qwen/Qwen3-0.6B-GGUF', 'master', 'a.gguf');
  assert.match(ms, /^https:\/\/modelscope\.cn\/models\//);
});

test('T2：catalogBaseUrl 把空源打到镜像（用注入 fetch 观察真实请求主机）', async () => {
  const seen = [];
  const spyFetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => [] };
  };
  // 空源搜索：请求必须打到镜像主机，而不是官方站。
  await searchModels('', 'qwen', { fetchImpl: spyFetch });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^https:\/\/hf-mirror\.com\//, `空源必须打到镜像，实际：${seen[0]}`);
  assert.equal(/huggingface\.co/.test(seen[0]), false, '空源绝不能打到官方站');

  // 合法源仍走各自主机。
  seen.length = 0;
  await searchModels('modelscope', 'qwen', { fetchImpl: spyFetch });
  assert.match(seen[0], /^https:\/\/modelscope\.cn\//);
});

test('T2：空源搜索结果的 sourceId 也归一（否则回填草稿又落回未知源）', async () => {
  const spyFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ modelId: 'a/b-GGUF', tags: ['gguf'], downloads: 1, likes: 0 }],
  });
  const list = await searchModels('', 'qwen', { fetchImpl: spyFetch });
  assert.equal(list[0].sourceId, DEFAULT_LOCAL_MODEL_SOURCE_ID, '结果不得带回空 sourceId');
});

// ── T6：弹窗不得用旧闭包的源发请求 ─────────────────────────────────────────

test('T6：effect 把归一后的源**显式传给** runSearch（不依赖异步 state 生效）', () => {
  const source = stripComments(
    fs.readFileSync(path.join(SRC, 'localModel', 'ModelSearchModal.js'), 'utf8')
  );
  // 关键形态：先算出 resolvedSourceId，再把它作为第二个参数传进去。
  assert.ok(
    /resolveLocalModelSourceId\(initialSourceId\)/.test(source),
    'effect 里必须先把归一结果算成局部变量'
  );
  assert.ok(
    /runSearch\(seed,\s*resolvedSourceId\)/.test(source),
    '必须把归一后的源显式传给 runSearch（否则 runSearch 读的是旧闭包 sourceId）'
  );
  // runSearch 必须真的接收并使用这个覆盖值。
  assert.ok(
    /runSearch\s*=\s*async\s*\(\s*override\s*,\s*sourceOverride\s*\)/.test(source),
    'runSearch 必须接收 sourceOverride 形参'
  );
  assert.ok(
    /sourceOverride\s*!==\s*undefined\s*\?\s*sourceOverride\s*:\s*sourceId/.test(source),
    'runSearch 必须优先使用 sourceOverride'
  );
});

test('T6：事件对象绝不能被当成搜索词（历史 bug：搜的是 "[object Object]"）', () => {
  const source = stripComments(
    fs.readFileSync(path.join(SRC, 'localModel', 'ModelSearchModal.js'), 'utf8')
  );
  // 调用点必须包一层箭头函数，不能把 onPress/onSubmitEditing 直接挂 runSearch。
  assert.equal(
    /onPress=\{runSearch\}/.test(source),
    false,
    'onPress 不得直接挂 runSearch（RN 会把事件对象当第一个参数传进去）'
  );
  assert.equal(
    /onSubmitEditing=\{runSearch\}/.test(source),
    false,
    'onSubmitEditing 不得直接挂 runSearch（同上）'
  );
  assert.ok(
    /onPress=\{\(\)\s*=>\s*runSearch\(\)\}/.test(source),
    'onPress 必须显式无参调用'
  );
  assert.ok(
    /onSubmitEditing=\{\(\)\s*=>\s*runSearch\(\)\}/.test(source),
    'onSubmitEditing 必须显式无参调用'
  );
  // 且 runSearch 自己要防住「非字符串 override」——同类错误复现时不再静默空结果。
  assert.ok(
    /typeof override === 'string'/.test(source),
    'runSearch 必须只把字符串当作 override（否则事件对象会变成 "[object Object]"）'
  );
});
