import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  bucketIdForTimestamp,
  buildMemoryListData,
  DAY_MS,
  groupSessionsByAge,
  MEMORY_BUCKETS,
  PINNED_GROUP_ID,
} from '../src/memory/memoryBuckets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'MemoryScreen.js'), 'utf8');

const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();

function session(id, ageDays, extra = {}) {
  return { id, updatedAt: NOW - ageDays * DAY_MS, ...extra };
}

test('时间档边界：最近/一天前/一周前/一个月前/半年前/一年前', () => {
  assert.equal(bucketIdForTimestamp(NOW, NOW), 'recent');
  assert.equal(bucketIdForTimestamp(NOW - 0.5 * DAY_MS, NOW), 'recent');
  assert.equal(bucketIdForTimestamp(NOW - 1 * DAY_MS, NOW), 'day');
  assert.equal(bucketIdForTimestamp(NOW - 6.9 * DAY_MS, NOW), 'day');
  assert.equal(bucketIdForTimestamp(NOW - 7 * DAY_MS, NOW), 'week');
  assert.equal(bucketIdForTimestamp(NOW - 29 * DAY_MS, NOW), 'week');
  assert.equal(bucketIdForTimestamp(NOW - 30 * DAY_MS, NOW), 'month');
  assert.equal(bucketIdForTimestamp(NOW - 179 * DAY_MS, NOW), 'month');
  assert.equal(bucketIdForTimestamp(NOW - 180 * DAY_MS, NOW), 'halfYear');
  assert.equal(bucketIdForTimestamp(NOW - 364 * DAY_MS, NOW), 'halfYear');
  assert.equal(bucketIdForTimestamp(NOW - 365 * DAY_MS, NOW), 'year');
  assert.equal(bucketIdForTimestamp(NOW - 800 * DAY_MS, NOW), 'year');
  // 无时间戳的旧会话落入最后一档，而不是被当成“最近”
  assert.equal(bucketIdForTimestamp(0, NOW), 'year');
});

test('分组：置顶单独成组，其余按时间从新到旧，空组不出现', () => {
  const groups = groupSessionsByAge([
    session('recent-1', 0.2),
    session('recent-2', 0.9),
    session('day-1', 3),
    session('year-1', 500),
    session('pin-1', 400, { pinned: true }),
    session('pin-2', 2, { pinned: true }),
  ], NOW);

  assert.deepEqual(groups.map(group => group.id), [PINNED_GROUP_ID, 'recent', 'day', 'year']);
  assert.deepEqual(groups[0].sessions.map(item => item.id), ['pin-1', 'pin-2']);
  assert.deepEqual(groups[1].sessions.map(item => item.id), ['recent-1', 'recent-2']);
  // 没有一周前/一个月前/半年前的会话，就不出现这些组
  assert.equal(groups.some(group => group.id === 'week'), false);
  assert.equal(groups.some(group => group.id === 'month'), false);
  assert.equal(groups.some(group => group.id === 'halfYear'), false);
});

test('空输入与非法项安全返回', () => {
  assert.deepEqual(groupSessionsByAge(null, NOW), []);
  assert.deepEqual(groupSessionsByAge([{ updatedAt: NOW }], NOW), []);
});

test('扁平列表：折叠只出头，展开才插入会话行', () => {
  const groups = groupSessionsByAge([
    session('a', 0.2),
    session('b', 3),
  ], NOW);

  const collapsed = buildMemoryListData(groups, new Set());
  assert.deepEqual(collapsed.map(item => item.kind), ['header', 'header']);
  assert.equal(collapsed[0].count, 1);
  assert.equal(collapsed[0].label, '最近');

  const expanded = buildMemoryListData(groups, new Set(['recent']));
  assert.deepEqual(expanded.map(item => item.kind), ['header', 'session', 'header']);
  assert.equal(expanded[1].session.id, 'a');
  assert.equal(expanded[2].groupId, 'day');
});

test('档位定义完整', () => {
  assert.deepEqual(MEMORY_BUCKETS.map(item => item.id), ['recent', 'day', 'week', 'month', 'halfYear', 'year']);
  assert.equal(MEMORY_BUCKETS[MEMORY_BUCKETS.length - 1].maxAge, undefined);
});

test('记忆界面接入分组折叠与展开全部', () => {
  assert.ok(SCREEN_SOURCE.includes("from './memory/memoryBuckets.js'"));
  assert.ok(SCREEN_SOURCE.includes('groupSessionsByAge'));
  assert.ok(SCREEN_SOURCE.includes('buildMemoryListData'));
  assert.ok(SCREEN_SOURCE.includes('expandedGroups'));
  assert.ok(SCREEN_SOURCE.includes('toggleGroup'));
  assert.ok(SCREEN_SOURCE.includes('toggleAllGroups'));
  assert.ok(SCREEN_SOURCE.includes('展开全部'));
  assert.ok(SCREEN_SOURCE.includes('折叠全部'));
  // 编辑模式强制展开，保证折叠里的会话可被点选
  assert.ok(SCREEN_SOURCE.includes('editing ? new Set(groups.map(group => group.id))'));
  // 首屏默认展开第一组，避免只剩标题的回归（且只自动展开一次）
  assert.ok(SCREEN_SOURCE.includes('autoExpandedRef'));
  assert.ok(SCREEN_SOURCE.includes('setExpandedGroups(new Set([groups[0].id]))'));
});
