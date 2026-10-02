import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_USABLE_MEMORY_RATIO,
  buildModelSummary,
  classifyModelMemory,
  estimateModelMemory,
  parseParamScaleB,
  parseQuantization,
  rankModelFiles,
} from '../src/localModel/modelCompatibility.js';

test('parseQuantization：识别常见量化等级与比特数', () => {
  assert.deepEqual(parseQuantization('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), {
    label: 'Q4_K_M',
    bitsPerWeight: 4.85,
    family: 'Q',
  });
  assert.equal(parseQuantization('model-q8_0.gguf').label, 'Q8_0');
  assert.equal(parseQuantization('Llama-3-8B-IQ4_XS.gguf').label, 'IQ4_XS');
  assert.equal(parseQuantization('model-f16.gguf').label, 'F16');
  assert.equal(parseQuantization('phi-3-mini-4k-instruct-q4.gguf'), null);
  assert.equal(parseQuantization(''), null);
});

test('parseQuantization：Q4_K 不抢占更具体的 Q4_K_M', () => {
  assert.equal(parseQuantization('x-Q4_K_M.gguf').label, 'Q4_K_M');
  assert.equal(parseQuantization('x-Q4_K_S.gguf').label, 'Q4_K_S');
  assert.equal(parseQuantization('x-Q4_K.gguf').label, 'Q4_K');
});

test('parseQuantization：兼容去下划线与大小写写法', () => {
  assert.equal(parseQuantization('model-Q4KM.gguf').label, 'Q4_K_M');
  assert.equal(parseQuantization('model-q4km.gguf').label, 'Q4_K_M');
});

test('parseParamScaleB：解析参数规模', () => {
  assert.equal(parseParamScaleB('Qwen2.5-1.5B-Instruct'), 1.5);
  assert.equal(parseParamScaleB('Llama-3-8B'), 8);
  assert.equal(parseParamScaleB('phi-3-mini-4k-instruct-fp16'), 0);
  assert.equal(parseParamScaleB(''), 0);
});

test('estimateModelMemory：权重随参数量与比特数增长', () => {
  const small = estimateModelMemory({ paramBillion: 1.5, bitsPerWeight: 4.85, contextSize: 2048 });
  const large = estimateModelMemory({ paramBillion: 7, bitsPerWeight: 4.85, contextSize: 2048 });
  assert.ok(small.weightsBytes > 0);
  assert.ok(large.weightsBytes > small.weightsBytes);
  assert.ok(large.kvBytes > small.kvBytes);
  assert.equal(small.totalBytes, small.weightsBytes + small.kvBytes + small.overheadBytes);
  const zero = estimateModelMemory({});
  assert.equal(zero.totalBytes, 0);
});

test('estimateModelMemory：上下文越大 KV 越大', () => {
  const short = estimateModelMemory({ paramBillion: 3, bitsPerWeight: 5.67, contextSize: 2048 });
  const long = estimateModelMemory({ paramBillion: 3, bitsPerWeight: 5.67, contextSize: 8192 });
  assert.ok(long.kvBytes > short.kvBytes);
  assert.equal(long.weightsBytes, short.weightsBytes);
});

test('classifyModelMemory：三档分级与未知', () => {
  const total = 8 * 1024 ** 3;
  const budget = total * DEVICE_USABLE_MEMORY_RATIO;
  assert.equal(classifyModelMemory(budget * 0.5, { totalMemoryBytes: total }).tier, 'recommended');
  assert.equal(classifyModelMemory(budget * 0.9, { totalMemoryBytes: total }).tier, 'tight');
  assert.equal(classifyModelMemory(budget * 1.5, { totalMemoryBytes: total }).tier, 'incompatible');
  assert.equal(classifyModelMemory(0, { totalMemoryBytes: total }).tier, 'unknown');
  assert.equal(classifyModelMemory(1000, { totalMemoryBytes: 0 }).tier, 'unknown');
});

test('classifyModelMemory：缺内存信息不误判为推荐', () => {
  const result = classifyModelMemory(4 * 1024 ** 3, { totalMemoryBytes: 0 });
  assert.equal(result.tier, 'unknown');
  assert.equal(result.label, '内存未知');
});

test('buildModelSummary：整合量化、参数与兼容分级', () => {
  const summary = buildModelSummary(
    { name: 'Qwen2.5-1.5B-Instruct-Q4_K_M', quant: 'Q4_K_M', paramSize: 1.5 },
    { totalMemoryBytes: 12 * 1024 ** 3, contextSize: 2048 }
  );
  assert.equal(summary.quantLabel, 'Q4_K_M');
  assert.equal(summary.paramLabel, '1.5B');
  assert.equal(summary.compatibility.tier, 'recommended');
  assert.ok(summary.memory.totalBytes > 0);
});

test('buildModelSummary：名称可兜底解析且缺信息时为未知', () => {
  const named = buildModelSummary({ name: 'Llama-3-8B-Q5_K_M.gguf' }, { totalMemoryBytes: 0 });
  assert.equal(named.quantLabel, 'Q5_K_M');
  assert.equal(named.paramLabel, '8B');
  assert.equal(named.compatibility.tier, 'unknown');
  const empty = buildModelSummary({}, {});
  assert.equal(empty.quantLabel, '');
  assert.equal(empty.paramLabel, '');
  assert.equal(empty.memory.totalBytes, 0);
});

test('rankModelFiles：推荐在前、跑不了沉底，同级按体积升序', () => {
  const files = [
    { path: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', size: 9 * 1024 ** 3 },
    { path: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', size: 2 * 1024 ** 3 },
    { path: 'Mistral-7B-Instruct-Q4_K_M.gguf', size: 4.7 * 1024 ** 3 },
    { path: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', size: 0.5 * 1024 ** 3 },
  ];
  const ranked = rankModelFiles(files, { totalMemoryBytes: 8 * 1024 ** 3 });
  // 8GB 设备：0.5B/3B 推荐，7B 难跑，14B 跑不了
  assert.deepEqual(
    ranked.map(item => item.file.path),
    [
      'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
      'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
      'Mistral-7B-Instruct-Q4_K_M.gguf',
      'Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    ]
  );
  assert.equal(ranked[0].summary.compatibility.tier, 'recommended');
  assert.equal(ranked[3].summary.compatibility.tier, 'incompatible');
});

test('rankModelFiles：无内存信息时全部 unknown，仍按体积升序', () => {
  const files = [
    { path: 'b-7B-Q4_K_M.gguf', size: 5 },
    { path: 'a-1B-Q4_K_M.gguf', size: 1 },
  ];
  const ranked = rankModelFiles(files, { totalMemoryBytes: 0 });
  assert.equal(ranked[0].summary.compatibility.tier, 'unknown');
  assert.deepEqual(ranked.map(item => item.file.path), ['a-1B-Q4_K_M.gguf', 'b-7B-Q4_K_M.gguf']);
  // 非数组兜底
  assert.deepEqual(rankModelFiles(null), []);
});
