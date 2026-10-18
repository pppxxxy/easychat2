// S2：向量索引的「隐式引用契约」加显式护栏。
//
// 契约内容（vector.js updateVectorIndex）：
//   updater 没改动内容时**必须原样返回同一个数组引用**，否则 saveVectorIndexInternal
//   会把整条索引重新 normalize + stringify + 写盘。实测 1024 维下 1000 条 ≈ 19.8MB、
//   stringify 145ms —— 每次落盘都白付一遍。
//
// 这条契约此前是**隐式**的：没有任何机制发现上游破坏了它。审核助手指出：
// 「上游一旦改动引用方式，轻则性能静默退化、重则改动不落盘，无任何拦截」。
//
// 本文件钉两件事：
//   ① 原样返回同一引用 ⇒ 不写盘、不报诊断（正常路径必须零成本）；
//   ② 返回新引用但内容等价 ⇒ **仍然写盘**（正确性优先，绝不因优化丢改动），
//      同时留一条诊断让退化可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');
const vectorPath = path.join(SRC_DIR, 'storage', 'vector.js');

const diagnostics = [];
function resetDiagnostics() { diagnostics.length = 0; }

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    map,
    writes,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) { writes.push(key); map.set(key, String(value)); },
    async removeItem(key) { writes.push(`rm:${key}`); map.delete(key); },
    async getAllKeys() { return [...map.keys()]; },
    async multiRemove(keys) { (keys || []).forEach(k => map.delete(k)); },
  };
}

const transpiled = new Map();
function compileToCjs(absPath) {
  if (transpiled.has(absPath)) return transpiled.get(absPath);
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false, configFile: false, filename: absPath,
    presets: [[PRESET_ENV, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  transpiled.set(absPath, code);
  return code;
}

function loadVector(storage) {
  const originalLoad = Module._load;
  const mainCode = compileToCjs(vectorPath);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: storage };
    }
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return {
        __esModule: true,
        recordDiagnostic: (kind, error, ctx) => diagnostics.push({ kind, msg: String((error && error.message) || error), ctx }),
      };
    }
    if (request === 'expo-file-system/legacy' || request === 'expo-file-system') {
      return { __esModule: true, documentDirectory: 'file:///doc/', getInfoAsync: async () => ({ exists: false }) };
    }
    if (request === 'expo-sqlite') return { __esModule: true, openDatabaseSync: () => null };
    if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
      return { __esModule: true, tActive: key => String(key) };
    }
    if (parent && parent.filename && request.startsWith('.')) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [base, `${base}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const mod = new Module(candidate);
          mod.filename = candidate;
          mod.paths = Module._nodeModulePaths(path.dirname(candidate));
          mod._compile(compileToCjs(candidate), candidate);
          return mod.exports;
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC_DIR}${path.sep}`)) delete Module._cache[key];
    }
    const mod = new Module(vectorPath);
    mod.filename = vectorPath;
    mod.paths = Module._nodeModulePaths(path.dirname(vectorPath));
    mod._compile(mainCode, vectorPath);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const META_KEY = '@easychat2_vector_index::c1';

// 一条带向量的真实形状分段（dim=4，向量直接内联，模拟已 hydrate 的索引）。
// 注意：normalizeVectorEntry 需要 id / text 等字段，缺了会被规范成空串，
// 导致「读回来的索引」与「我传进去的」形状不同——第一版就是这么写错的。
function makeEntry(id, vec = [0.1, 0.2, 0.3, 0.4]) {
  return {
    id: `id-${id}`,
    messageId: id,
    sessionId: 's1',
    role: 'user',
    at: 1700000000000,
    text: `text-${id}`,
    dim: 4,
    vector: vec,
  };
}

// 种子：元数据只存「除向量外」的字段（与真实分片布局一致），向量落分片。
function seedIndex() {
  const entries = [makeEntry('m1'), makeEntry('m2')];
  return { [META_KEY]: JSON.stringify(entries.map(({ vector, ...rest }) => rest)), entries };
}

test.beforeEach(() => { resetDiagnostics(); });

test('正常路径：原样返回同一引用 ⇒ 不写盘、不报诊断（必须零成本）', async () => {
  const { entries, ...initial } = seedIndex();
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  const before = storage.writes.length;
  const result = await vector.updateVectorIndex('c1', current => current);
  assert.equal(result.length, entries.length);
  assert.equal(storage.writes.length, before, '内容没变就**不得**写盘（这正是契约的全部意义）');
  assert.equal(diagnostics.length, 0, '正常路径不该产生任何诊断');
});

test('契约护栏：返回新引用但内容等价 ⇒ 仍写盘（正确性优先）+ 留诊断', async () => {
  const { entries, ...initial } = seedIndex();
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  const before = storage.writes.length;
  // 上游做了无意义的复制：内容一样，但引用不同。
  await vector.updateVectorIndex('c1', current => current.map(item => ({ ...item })));
  assert.ok(storage.writes.length > before, '必须照常写盘（绝不因优化丢改动）');
  const contract = diagnostics.filter(d => /vectorIndexReferenceContract/.test(d.msg));
  assert.equal(contract.length, 1, '必须留一条「引用契约被破坏」的诊断，让性能退化可见');
});

test('对照：内容真的变了 ⇒ 正常写盘且不误报契约问题', async () => {
  const { entries, ...initial } = seedIndex();
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  const before = storage.writes.length;
  await vector.updateVectorIndex('c1', current => (
    current.map(item => (item.messageId === 'm1' ? { ...item, dim: 8 } : item))
  ));
  assert.ok(storage.writes.length > before, '内容变化必须写盘');
  const contract = diagnostics.filter(d => /vectorIndexReferenceContract/.test(d.msg));
  assert.equal(contract.length, 0, '真变化不该被误报成契约问题');
});

test('对照：向量元素变了也算真变化（不能因「引用不同但结构相同」漏判）', async () => {
  const { entries, ...initial } = seedIndex();
  const storage = makeStorage(initial);
  const vector = loadVector(storage);
  await vector.updateVectorIndex('c1', current => (
    current.map(item => (
      item.messageId === 'm1' ? { ...item, vector: [0.9, 0.9, 0.9, 0.9] } : item
    ))
  ));
  const contract = diagnostics.filter(d => /vectorIndexReferenceContract/.test(d.msg));
  assert.equal(contract.length, 0, '向量元素变化是真变化，不该报契约问题');
});

test('接线：护栏必须存在于 updateVectorIndex 内，且诊断走 i18n key', () => {
  const source = fs.readFileSync(vectorPath, 'utf8');
  assert.ok(source.includes('isDeepEqualIndex('), '必须有深比较护栏');
  assert.ok(
    /error\.storage\.vectorIndexReferenceContract/.test(source),
    '诊断必须走 i18n key（用户可见文案不硬编码）'
  );
  // 护栏必须在「引用相等」短路**之后**（正常路径不能被它拖慢）。
  const refCheck = source.indexOf('if (next === status.index) return status.index;');
  const guard = source.indexOf('isDeepEqualIndex(next, status.index)');
  assert.ok(refCheck > 0 && guard > refCheck, '深比较必须在引用相等短路之后');
});
