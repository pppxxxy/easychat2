// 精选模型目录（v5 Stage E）行为测试：设备适配筛选与排序（纯函数）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURED_MODELS,
  FEATURED_USABLE_RATIO,
  isFeaturedSourceAvailable,
  selectFeaturedModels,
} from '../src/localModel/featured.js';

test('FEATURED_MODELS：精选条目含仓库坐标与规模，均为已知源', () => {
  assert.ok(FEATURED_MODELS.length >= 4);
  for (const item of FEATURED_MODELS) {
    assert.ok(item.id && item.name && item.repoId, '条目应有 id/name/repoId');
    assert.ok(item.paramSize > 0 && item.minMemoryBytes > 0, '应有规模与内存下限');
    assert.equal(isFeaturedSourceAvailable(item.sourceId || 'huggingface'), true);
  }
});

test('selectFeaturedModels：内存未知时全部保留并标注 memoryKnown=false', () => {
  const list = selectFeaturedModels({ totalMemoryBytes: 0 });
  assert.equal(list.length, FEATURED_MODELS.length);
  assert.equal(list.every(item => item.memoryKnown === false), true);
});

test('selectFeaturedModels：内存充足时按体积升序，小模型在前', () => {
  const list = selectFeaturedModels({ totalMemoryBytes: 16 * 1024 * 1024 * 1024 });
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(list[i - 1].minMemoryBytes <= list[i].minMemoryBytes, '应按内存下限升序');
  }
  assert.equal(list.length, FEATURED_MODELS.length, '大内存设备应保留全部');
});

test('selectFeaturedModels：小内存设备过滤掉超出预算的条目', () => {
  // 2GB 设备：可用预算 1.2GB，只保留 minMemoryBytes ≤ 1.2GB 的条目（LFM2 1.2B）
  const list = selectFeaturedModels({ totalMemoryBytes: 2 * 1024 * 1024 * 1024 });
  assert.ok(list.length >= 1, '至少保留最小模型');
  assert.ok(list.every(item => item.fits), '过滤后应全部适配');
  assert.ok(list.every(item => item.minMemoryBytes <= 2 * 1024 * 1024 * 1024 * FEATURED_USABLE_RATIO));
  assert.ok(!list.some(item => item.id === 'qwen3-4b'), '4B 应被过滤');
});

test('selectFeaturedModels：透传 sourceId，内存充足时也不误标 tooBig', () => {
  const list = selectFeaturedModels({ totalMemoryBytes: 16 * 1024 * 1024 * 1024, sourceId: 'hf-mirror' });
  assert.equal(list.every(item => item.sourceId === 'hf-mirror'), true);
  assert.equal(list.every(item => item.fits), true);
});
