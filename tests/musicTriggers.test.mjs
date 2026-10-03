// 听歌时间轴触发与评论 prompt 的纯函数测试。
// 触发判定的核心语义：正常推进只触发「越过」的点（起点排他、终点包含）；
// seek 落定后，新位置之前的点一律视为已放过的历史，不再回放触发。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEEK_JUMP_THRESHOLD_MS,
  collectTriggersToCross,
  isSeekJump,
  makeTriggerId,
  normalizeTriggers,
  resolveFiredIdsAtPosition,
} from '../src/music/triggers.js';
import {
  buildOpeningCommentPrompt,
  buildTriggerCommentPrompt,
  formatPlaybackPosition,
} from '../src/music/commentPrompts.js';

test('打点归一化：升序、同刻去重、非法剔除、备注截断', () => {
  const list = normalizeTriggers([
    { id: 'b', atMs: 62000, note: '副歌' },
    { id: 'a', atMs: 12000 },
    { id: 'b', atMs: 62000, note: '重复' },
    { id: 'c', atMs: -1 },
    { id: 'd', atMs: 1000, note: 'x'.repeat(300) },
  ]);
  assert.deepEqual(list.map(item => item.id), ['d', 'a', 'b'], '按 atMs 升序，d 的 1000ms 最先');
  assert.equal(list[2].note, '副歌', '同刻同 id 去重保留首条');
  assert.equal(list[0].note.length, 120);
  assert.equal(normalizeTriggers('not-array').length, 0);
  assert.equal(normalizeTriggers([null, {}]).length, 0);
});

test('打点 id：缺 id 自动生成，makeTriggerId 不重复', () => {
  const list = normalizeTriggers([{ atMs: 1000 }, { atMs: 2000 }]);
  assert.ok(list[0].id && list[1].id);
  assert.notEqual(list[0].id, list[1].id);
  assert.notEqual(makeTriggerId(1), makeTriggerId(1));
});

test('seek 判定：超过阈值才算拖动，阈值常量为 2500ms', () => {
  assert.equal(SEEK_JUMP_THRESHOLD_MS, 2500);
  assert.equal(isSeekJump(100000, 102000), false, '100ms 一跳的正常推进不算 seek');
  assert.equal(isSeekJump(100000, 102001), false, '2001ms 仍在阈值内');
  assert.equal(isSeekJump(100000, 103000), true, '3000ms 越过阈值');
  assert.equal(isSeekJump(50000, 40000), true, '回退同样按绝对差判定');
  assert.equal(isSeekJump(50000, 51000), false);
  assert.equal(isSeekJump(Number.NaN, 1000), false);
});

test('推进触发：区间 (from, to] 内的点触发，起点排他防同刻双触发', () => {
  const triggers = [
    { id: 'a', atMs: 1000 },
    { id: 'b', atMs: 5000 },
    { id: 'c', atMs: 9000 },
  ];
  assert.deepEqual(
    collectTriggersToCross(triggers, 0, 5000).map(item => item.id),
    ['a', 'b'],
    '终点打点在到达这一跳时就应触发'
  );
  // 下一跳 from=5000：b 不得再次触发
  assert.deepEqual(
    collectTriggersToCross(triggers, 5000, 9000).map(item => item.id),
    ['c']
  );
  assert.deepEqual(collectTriggersToCross(triggers, 9000, 9000), [], '零推进不触发');
  assert.deepEqual(collectTriggersToCross(triggers, 9000, 8000), [], '倒退不触发');
  assert.deepEqual(collectTriggersToCross('bad', 0, 1000), []);
});

test('seek 落定：新位置之前视为已触发历史，之后保持未触发', () => {
  const triggers = [
    { id: 'a', atMs: 1000 },
    { id: 'b', atMs: 5000 },
    { id: 'c', atMs: 9000 },
  ];
  let fired = resolveFiredIdsAtPosition(triggers, 6000);
  assert.deepEqual([...fired].sort(), ['a', 'b']);
  assert.equal(fired.has('c'), false);
  // 回跳到开头重播：全部重置为未触发
  fired = resolveFiredIdsAtPosition(triggers, 0);
  assert.equal(fired.size, 0);
  // seek 到末尾附近：全部视为已触发
  fired = resolveFiredIdsAtPosition(triggers, 12000);
  assert.deepEqual([...fired].sort(), ['a', 'b', 'c']);
  assert.equal(resolveFiredIdsAtPosition(triggers, Number.NaN).size, 0);
});

test('完整时序：推进→seek→重播的组合语义', () => {
  const triggers = [
    { id: 'a', atMs: 1000 },
    { id: 'b', atMs: 5000 },
    { id: 'c', atMs: 9000 },
  ];
  // 模拟界面：fired 与 position 由界面持有，seek 落定后二者都跳到新位置。
  let positionMs = 0;
  let fired = new Set();
  const advance = nextMs => {
    if (isSeekJump(positionMs, nextMs)) {
      positionMs = nextMs;
      fired = resolveFiredIdsAtPosition(triggers, nextMs);
      return []; // seek 本身不触发任何点
    }
    const crossed = collectTriggersToCross(triggers, positionMs, nextMs)
      .map(item => item.id)
      .filter(id => !fired.has(id));
    crossed.forEach(id => fired.add(id));
    positionMs = nextMs;
    return crossed;
  };
  assert.deepEqual(advance(2000), ['a']);
  assert.deepEqual(advance(3000), [], '未到下一个点');
  assert.deepEqual(advance(5100), ['b']);
  // seek 回跳到开头：不触发任何点，历史清空
  assert.deepEqual(advance(0), []);
  assert.equal(fired.size, 0);
  // 重播到同一位置：a 再次触发
  assert.deepEqual(advance(2000), ['a']);
  // seek 跳过 c：c 视为已放过的历史，继续推进不补触发
  assert.deepEqual(advance(12000), []);
  assert.deepEqual(advance(12100), []);
});

test('进度格式：mm:ss 与 h:mm:ss，非法入参按 0 处理', () => {
  assert.equal(formatPlaybackPosition(0), '0:00');
  assert.equal(formatPlaybackPosition(65000), '1:05');
  assert.equal(formatPlaybackPosition(60000 + 5 * 60000), '6:00');
  assert.equal(formatPlaybackPosition(3661000), '1:01:01');
  assert.equal(formatPlaybackPosition(-5), '0:00');
  assert.equal(formatPlaybackPosition('bad'), '0:00');
});

test('打点评论 prompt：包含歌名、进度与打点备注', () => {
  const withNote = buildTriggerCommentPrompt({
    songName: '晴天',
    positionMs: 65000,
    durationMs: 269000,
    note: '聊聊这段副歌',
  });
  assert.ok(withNote.includes('《晴天》'));
  assert.ok(withNote.includes('1:05'));
  assert.ok(withNote.includes('4:29'));
  assert.ok(withNote.includes('聊聊这段副歌'));
  const withoutNote = buildTriggerCommentPrompt({ songName: '', positionMs: 1000, durationMs: 0 });
  assert.ok(withoutNote.includes('一首歌'), '歌名缺失时用兜底称呼');
  assert.ok(withoutNote.includes('进度 0:01'));
  assert.ok(!withoutNote.includes('undefined'), '任何字段缺失不得把 undefined 带进 prompt');
});

test('开场评论 prompt：歌名与全长就位，不出现进度数字', () => {
  const prompt = buildOpeningCommentPrompt({ songName: '七里香', durationMs: 300000 });
  assert.ok(prompt.includes('《七里香》'));
  assert.ok(prompt.includes('5:00'));
  assert.ok(prompt.includes('刚开始播放'));
});
