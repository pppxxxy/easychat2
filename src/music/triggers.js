// 听歌时间轴打点纯函数：打点的生成、归一化，以及「播放进度推进时哪些点该触发」的判定。
// 触发判定必须只依赖传入状态（fired 集合由界面持有），保证 seek/重播/循环播放语义可被 Node 测试穷举。

// 位置回退/前进超过该阈值视为 seek（拖动进度条），而非正常的播放推进。
// 正常播放 100ms 一跳不会越过它；小于阈值的微小回退（解码抖动）不重算已触发集合。
export const SEEK_JUMP_THRESHOLD_MS = 2500;

export function makeTriggerId(now = Date.now()) {
  return `t-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

// 归一化打点列表：atMs 取整且非负、note 截断；按 atMs 升序，同刻去重。
// note 为空允许（打点可以不带备注，交给角色自由发挥）。
export function normalizeTriggers(list, { noteMax = 120 } = {}) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const source = item && typeof item === 'object' ? item : {};
    const atMs = Math.floor(Number(source.atMs));
    if (!Number.isFinite(atMs) || atMs < 0) return;
    const id = String(source.id || '').trim() || makeTriggerId(atMs);
    if (seen.has(`${id}\u0000${atMs}`)) return;
    seen.add(`${id}\u0000${atMs}`);
    const note = String(source.note || '').trim().slice(0, noteMax);
    result.push({ id, atMs, note });
  });
  result.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  return result;
}

export function isSeekJump(previousMs, nextMs, thresholdMs = SEEK_JUMP_THRESHOLD_MS) {
  const from = Number(previousMs);
  const to = Number(nextMs);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return Math.abs(to - from) > thresholdMs;
}

// 正常推进（from → to 前向）时落在区间 (from, to] 内的打点应触发。
// 起点排除：from 本身的打点在上一次推进时已经处理过，重复包含会造成同刻双触发。
export function collectTriggersToCross(triggers, fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return (Array.isArray(triggers) ? triggers : [])
    .filter(item => item && Number.isFinite(Number(item.atMs)) && Number(item.atMs) > from && Number(item.atMs) <= to);
}

// seek 落定后重算「已触发」集合：新位置之前的打点视为已放过的历史，不再回放触发；
// 新位置之后的打点保留未触发状态，继续播放时仍会正常触发。
export function resolveFiredIdsAtPosition(triggers, positionMs) {
  const position = Number(positionMs);
  const fired = new Set();
  if (!Number.isFinite(position)) return fired;
  (Array.isArray(triggers) ? triggers : []).forEach(item => {
    if (item && Number.isFinite(Number(item.atMs)) && Number(item.atMs) <= position) fired.add(String(item.id || ''));
  });
  return fired;
}
