import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDownloadUrl,
  catalogProviderForSource,
  classifyGgufFile,
  defaultRevisionForSource,
  isGgufFile,
  listModelFiles,
  parseDownloadUrl,
  parseHuggingFaceSearch,
  parseHuggingFaceTree,
  parseModelScopeFiles,
  parseModelScopeSearch,
  rewriteDownloadSourceUrl,
  searchModels,
} from '../src/localModel/modelCatalog.js';
import { LOCAL_MODEL_DOWNLOAD_SOURCES } from '../src/localModel/modelState.js';

test('下载源预设包含魔搭社区', () => {
  const ids = LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => source.id);
  assert.ok(ids.includes('modelscope'));
  const modelscope = LOCAL_MODEL_DOWNLOAD_SOURCES.find(source => source.id === 'modelscope');
  assert.equal(modelscope.baseUrl, 'https://modelscope.cn');
});

test('catalogProviderForSource：镜像与魔搭映射到正确适配器', () => {
  assert.equal(catalogProviderForSource('huggingface'), 'huggingface');
  assert.equal(catalogProviderForSource('hf-mirror'), 'huggingface');
  assert.equal(catalogProviderForSource('modelscope'), 'modelscope');
  assert.equal(catalogProviderForSource('unknown'), 'huggingface');
});

test('isGgufFile / classifyGgufFile：识别模型与投影文件', () => {
  assert.equal(isGgufFile('a/b/model.Q4_K_M.gguf'), true);
  assert.equal(isGgufFile('a/b/model.safetensors'), false);
  assert.equal(classifyGgufFile('repo/model-q4.gguf'), 'model');
  assert.equal(classifyGgufFile('repo/mmproj-model-f16.gguf'), 'projector');
  assert.equal(classifyGgufFile('repo/config.json'), null);
});

test('parseHuggingFaceSearch：仅保留含 gguf 标签的仓库', () => {
  const json = [
    { id: 'org/gguf-model', modelId: 'org/gguf-model', tags: ['GGUF', 'text'], downloads: 1200, likes: 5 },
    { id: 'org/plain', modelId: 'org/plain', tags: ['text'], downloads: 9 },
    { modelId: '', tags: ['gguf'] },
  ];
  const results = parseHuggingFaceSearch(json);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    provider: 'huggingface',
    repoId: 'org/gguf-model',
    name: 'gguf-model',
    downloads: 1200,
    likes: 5,
    revision: 'main',
  });
  assert.deepEqual(parseHuggingFaceSearch(null), []);
});

test('parseHuggingFaceTree：只取 gguf/mmproj 并按体积排序', () => {
  const json = [
    { type: 'file', path: 'README.md', size: 10 },
    { type: 'file', path: 'model-q8.gguf', size: 900 },
    { type: 'file', path: 'model-q4.gguf', size: 400 },
    { type: 'file', path: 'mmproj-f16.gguf', size: 50 },
    { type: 'directory', path: 'sub' },
    { type: 'file', path: 'big.gguf', lfs: { size: 5000 }, size: 100 },
  ];
  const parsed = parseHuggingFaceTree(json, 'org/repo', 'main');
  assert.equal(parsed.repoId, 'org/repo');
  assert.deepEqual(parsed.modelFiles.map(file => file.path), ['model-q4.gguf', 'model-q8.gguf', 'big.gguf']);
  assert.deepEqual(parsed.projectorFiles.map(file => file.path), ['mmproj-f16.gguf']);
  assert.equal(parsed.modelFiles[2].size, 5000);
  assert.equal(parsed.modelFiles[0].kind, 'model');
  assert.equal(parsed.projectorFiles[0].kind, 'projector');
});

test('parseModelScopeSearch：读取 Data.Model.Models 并过滤 gguf 库', () => {
  const json = {
    Data: {
      Model: {
        Models: [
          { Path: 'Qwen', Name: 'Qwen2.5-gguf', Libraries: ['GGUF'], Downloads: 300 },
          { Path: 'Qwen', Name: 'Qwen2.5', Libraries: ['PyTorch'], Downloads: 90 },
          { Path: '', Name: 'bad', Libraries: ['gguf'] },
        ],
      },
    },
  };
  const results = parseModelScopeSearch(json);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    provider: 'modelscope',
    repoId: 'Qwen/Qwen2.5-gguf',
    name: 'Qwen2.5-gguf',
    downloads: 300,
    likes: 0,
    revision: 'master',
  });
  assert.deepEqual(parseModelScopeSearch({}), []);
});

test('parseModelScopeFiles：读取 Data.Files 跳过目录', () => {
  const json = {
    Data: {
      Files: [
        { Path: 'model-q4.gguf', Name: 'model-q4.gguf', Type: 'file', Size: 700 },
        { Path: 'mmproj.gguf', Name: 'mmproj.gguf', Type: 'file', Size: 40 },
        { Path: 'sub', Name: 'sub', Type: 'tree' },
      ],
    },
  };
  const parsed = parseModelScopeFiles(json, 'Qwen/Qwen2.5-gguf', 'master');
  assert.equal(parsed.revision, 'master');
  assert.deepEqual(parsed.modelFiles.map(file => file.path), ['model-q4.gguf']);
  assert.deepEqual(parsed.projectorFiles.map(file => file.path), ['mmproj.gguf']);
});

test('buildDownloadUrl：按来源拼接下载地址', () => {
  assert.equal(
    buildDownloadUrl('huggingface', 'org/repo', 'main', 'model q4.gguf'),
    'https://huggingface.co/org/repo/resolve/main/model%20q4.gguf'
  );
  assert.equal(
    buildDownloadUrl('hf-mirror', 'org/repo', 'main', 'model.gguf'),
    'https://hf-mirror.com/org/repo/resolve/main/model.gguf'
  );
  assert.equal(
    buildDownloadUrl('modelscope', 'Qwen/Qwen2.5-gguf', 'master', 'model.gguf'),
    'https://modelscope.cn/models/Qwen/Qwen2.5-gguf/resolve/master/model.gguf'
  );
  assert.equal(buildDownloadUrl('huggingface', '', 'main', 'm.gguf'), '');
});

test('parseDownloadUrl / rewriteDownloadSourceUrl：跨源改写并保留文件', () => {
  const parsed = parseDownloadUrl('https://huggingface.co/org/repo/resolve/main/model.gguf');
  assert.deepEqual(parsed, { repoId: 'org/repo', revision: 'main', filePath: 'model.gguf' });
  assert.equal(rewriteDownloadSourceUrl('https://huggingface.co/org/repo/resolve/main/model.gguf', 'hf-mirror'),
    'https://hf-mirror.com/org/repo/resolve/main/model.gguf');
  assert.equal(rewriteDownloadSourceUrl('https://modelscope.cn/models/org/repo/resolve/master/model.gguf', 'huggingface'),
    'https://huggingface.co/org/repo/resolve/master/model.gguf');
  assert.equal(rewriteDownloadSourceUrl('not-a-url', 'huggingface'), '');
  assert.equal(parseDownloadUrl('https://huggingface.co/org/repo'), null);
});

test('defaultRevisionForSource：魔搭用 master，其余用 main', () => {
  assert.equal(defaultRevisionForSource('modelscope'), 'master');
  assert.equal(defaultRevisionForSource('huggingface'), 'main');
});

test('searchModels：走注入 fetch 并补 sourceId', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ([{ id: 'org/gguf', modelId: 'org/gguf', tags: ['gguf'], downloads: 1 }]),
    };
  };
  const results = await searchModels('huggingface', 'qwen', { fetchImpl });
  assert.match(captured.url, /huggingface\.co\/api\/models\?search=qwen/);
  assert.equal(results[0].sourceId, 'huggingface');
  assert.equal(results[0].repoId, 'org/gguf');
});

test('searchModels：魔搭用 PUT 且解析 Data.Model.Models', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({ Data: { Model: { Models: [{ Path: 'Q', Name: 'g', Libraries: ['gguf'] }] } } }),
    };
  };
  const results = await searchModels('modelscope', 'qwen', { fetchImpl });
  assert.equal(captured.init.method, 'PUT');
  assert.equal(results[0].repoId, 'Q/g');
  assert.equal(results[0].sourceId, 'modelscope');
});

test('listModelFiles：按适配器分支读取文件', async () => {
  let captured = null;
  const fetchImpl = async (url) => {
    captured = url;
    return {
      ok: true,
      json: async () => ([{ type: 'file', path: 'a.gguf', size: 10 }]),
    };
  };
  const parsed = await listModelFiles('hf-mirror', 'org/repo', { fetchImpl });
  assert.match(captured, /huggingface\.co\/api\/models\/org\/repo\/tree\/main/);
  assert.equal(parsed.modelFiles[0].path, 'a.gguf');
});

test('searchModels：HTTP 失败时抛错', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => searchModels('huggingface', 'x', { fetchImpl }), /请求失败/);
});
