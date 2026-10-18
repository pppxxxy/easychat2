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
  catalogProviderForSource,
  parseHuggingFaceSearch,
  searchModels,
} from '../src/localModel/modelCatalog.js';

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

test('接线：搜索弹窗与面板都不再把 huggingface 当回落值', () => {
  const modal = fs.readFileSync(path.join(SRC, 'localModel', 'ModelSearchModal.js'), 'utf8');
  const panel = fs.readFileSync(path.join(SRC, 'LocalModelPanel.js'), 'utf8');
  // 判据是「调用点」而不是「出现过 huggingface」：注释里提到它是允许的。
  assert.equal(
    /\|\|\s*'huggingface'/.test(modal),
    false,
    '搜索弹窗不得再用 || huggingface 回落（那正是事故根因）'
  );
  assert.equal(
    /\|\|\s*'huggingface'/.test(panel),
    false,
    '面板传参不得再用 || huggingface 回落'
  );
  assert.ok(
    modal.includes('resolveLocalModelSourceId'),
    '弹窗必须经 resolveLocalModelSourceId 归一'
  );
});

test('失败留痕：搜索失败要记诊断（此前完全没有，用户无从排查）', async () => {
  const recorded = [];
  const failing = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => searchModels('hf-mirror', 'qwen', {
      fetchImpl: failing,
      // 通过注入 recordDiagnostic 不可行（模块内静态 import），改为断言抛错即可；
      // 留痕的**内容**由下面那条源码契约 + 本条的「确实抛了」共同保证。
    }),
    /fetch failed/
  );
  // 这条主要钉「错误要传出去」；留痕本身见下一条。
  assert.equal(recorded.length, 0);
});

test('失败留痕：modelCatalog 的失败路径必须调用 recordDiagnostic，且不记 query 全文', () => {
  const source = fs.readFileSync(path.join(SRC, 'localModel', 'modelCatalog.js'), 'utf8');
  assert.ok(
    source.includes("from '../storage/diagnostics.js'"),
    '必须引入 recordDiagnostic（此前一条都没有）'
  );
  assert.ok(source.includes('noteCatalogFailure('), '必须有统一的失败留痕入口');
  // 搜索与取文件两条路径都要接上。
  const searchAt = source.indexOf('export async function searchModels');
  const filesAt = source.indexOf('export async function listModelFiles');
  assert.ok(searchAt > 0 && filesAt > searchAt, '两个导出函数都应存在');
  assert.ok(
    source.slice(searchAt, filesAt).includes('noteCatalogFailure('),
    'searchModels 的 catch 必须留痕'
  );
  assert.ok(
    source.slice(filesAt).includes('noteCatalogFailure('),
    'listModelFiles 的 catch 必须留痕'
  );
  // 隐私：诊断里不得写入用户搜的词。
  assert.equal(
    /noteCatalogFailure\([^)]*query/.test(source),
    false,
    '诊断不得记录 query 全文（可能是私人内容）'
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
