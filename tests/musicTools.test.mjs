// FEAT-AC2：音乐工具域 + 播放器单例的门禁与行为。
//
// 纯 Node 直测（依赖全注入）：本文件 import 纯层（musicToolSchema / playerSettingsPure）
// 与工具层的**定义**部分。工具层里 storage/playerService 是惰性 require，
// 定义加载时不碰它们——所以这里能安全 import；真跑 execute 时才需要，测试用注入替换。
//
// 覆盖任务书 P1-4 要求的三类：
//   纯层：动作白名单外 → 拒；play/resume 必弹确认；read 模式不含 control_music
//   脏层：storage/playerService 全打桩；「每个动作都有实现」键级对账
//   结构：useMusicPlayer / MusicScreen 不得再直接 createAudioPlayer

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MUSIC_ACTIONS,
  MUSIC_ACTION_NAMES,
  MUSIC_CONFIRM_ACTIONS,
  actionNeedsConfirm,
  describeMusicValue,
  formatMusicDuration,
  renderMusicConfirmText,
  renderPlaylistList,
  renderTrackList,
  validateMusicAction,
} from '../src/workspace/musicToolSchema.js';
import {
  decideAfterFinish,
  MUSIC_PLAY_MODES,
  MUSIC_RATES,
  nextSequentialIndex,
  pickShuffleIndex,
} from '../src/music/playerSettingsPure.js';
import {
  MUSIC_READ_DEFINITIONS,
  MUSIC_TOOL_DEFINITIONS,
  MUSIC_WRITE_DEFINITIONS,
  __setMusicNativeModules,
  buildMusicApproval,
  setMusicToolRecorder,
} from '../src/workspace/toolDefs/musicTools.js';
import { AGENT_MODES, listToolsForMode, registerTool, unregisterTool } from '../src/agent/tools/registry.js';

const byName = name => MUSIC_TOOL_DEFINITIONS.find(item => item.name === name);
const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

// ---------- 纯层：确认分级 ----------

test('确认分级：**只有会出声的动作**要确认（play / resume）', () => {
  // 产品裁决是一条干净规则：会出声 → 弹确认；静音化或轻调整 → 不弹。
  assert.deepEqual([...MUSIC_CONFIRM_ACTIONS].sort(), ['play', 'resume'],
    '需要确认的必须恰好是 play 与 resume');
  for (const name of ['pause', 'stop', 'next', 'prev', 'seek', 'set_rate', 'set_play_mode']) {
    assert.equal(actionNeedsConfirm(name), false, `${name} 不该弹确认（静音化/轻调整）`);
  }
  // 白名单外一律 false（兜底，调用方本该先拒）
  assert.equal(actionNeedsConfirm('explode'), false);
});

test('动作白名单：9 个动作齐全，且每个都有 describe（结果文案要用）', () => {
  assert.deepEqual([...MUSIC_ACTION_NAMES].sort(), [
    'next', 'pause', 'play', 'prev', 'resume', 'seek', 'set_play_mode', 'set_rate', 'stop',
  ]);
  for (const name of MUSIC_ACTION_NAMES) {
    assert.ok(String(MUSIC_ACTIONS[name].describe || '').trim(), `${name} 缺 describe`);
  }
});

test('参数校验：白名单外动作 → 具体拒绝原因', () => {
  const msg = validateMusicAction('explode', {});
  assert.ok(msg, '必须拒绝');
  assert.match(msg, /未知动作/);
  assert.match(msg, /explode/);
  assert.match(msg, /play/, '要列出可用动作让模型纠正');
  // 缺 action
  assert.match(validateMusicAction('', {}), /缺少 action/);
});

test('参数校验：play 的 trackId/playlistId 二选一（都给是歧义，拒绝）', () => {
  assert.equal(validateMusicAction('play', {}), null, '都不给是有意的：放整个曲库');
  assert.equal(validateMusicAction('play', { trackId: 't1' }), null);
  assert.equal(validateMusicAction('play', { playlistId: 'p1' }), null);
  assert.match(validateMusicAction('play', { trackId: 't1', playlistId: 'p1' }), /只能给一个/);
});

test('参数校验：seek / set_rate / set_play_mode 的值域（不猜不修）', () => {
  assert.equal(validateMusicAction('seek', { positionSeconds: 30 }), null);
  assert.match(validateMusicAction('seek', { positionSeconds: -1 }), /≥ 0/);
  assert.match(validateMusicAction('seek', {}), /positionSeconds/);

  assert.equal(validateMusicAction('set_rate', { rate: 1.5 }), null);
  const badRate = validateMusicAction('set_rate', { rate: 3 });
  assert.match(badRate, /倍速只能是/);
  assert.match(badRate, /0\.5/, '要列出允许档位');

  assert.equal(validateMusicAction('set_play_mode', { playMode: 'shuffle' }), null);
  const badMode = validateMusicAction('set_play_mode', { playMode: 'random' });
  assert.match(badMode, /播放方式只能是/);
  assert.match(badMode, /sequential/);
  // 无参动作（pause 等）永远通过形状校验
  for (const name of ['pause', 'stop', 'next', 'prev', 'resume']) {
    assert.equal(validateMusicAction(name, {}), null, `${name} 不应需要参数`);
  }
});

test('参数校验：倍速/播放方式的允许值来自纯层常量（不手抄）', () => {
  // 值域必须与 playerSettingsPure 同源——两处各写一份必然漂移。
  for (const rate of MUSIC_RATES) {
    assert.equal(validateMusicAction('set_rate', { rate }), null, `${rate} 应合法`);
  }
  for (const mode of MUSIC_PLAY_MODES) {
    assert.equal(validateMusicAction('set_play_mode', { playMode: mode }), null, `${mode} 应合法`);
  }
});

test('文案：确认问句带歌名/歌单名（产品裁决要「将开始播放《歌名》」）', () => {
  assert.equal(renderMusicConfirmText({ action: 'play', trackName: '晴天' }), '将开始播放《晴天》，允许吗？');
  assert.match(renderMusicConfirmText({ action: 'play', playlistName: '通勤', count: 5 }),
    /将开始播放歌单《通勤》（5 首），允许吗？/);
  assert.equal(renderMusicConfirmText({ action: 'play' }), '将开始播放音乐（随机曲目），允许吗？');
  assert.equal(renderMusicConfirmText({ action: 'resume', trackName: '晴天' }), '将继续播放《晴天》，允许吗？');
  assert.equal(renderMusicConfirmText({ action: 'resume' }), '将继续播放当前曲目，允许吗？');
});

test('文案：时长与列表渲染（模型要能读懂 id 与时长）', () => {
  assert.equal(formatMusicDuration(0), '0:00');
  assert.equal(formatMusicDuration(65000), '1:05');
  assert.equal(formatMusicDuration(185000), '3:05');
  assert.equal(formatMusicDuration(-5), '0:00');

  const tracks = renderTrackList([
    { id: 't1', name: '晴天', durationMs: 269000 },
    { id: 't2', name: '稻香', durationMs: 0 },
  ]);
  assert.match(tracks, /晴天（4:29）.*id=t1/);
  assert.match(tracks, /稻香.*id=t2/);
  assert.equal(renderTrackList([]), '');

  const lists = renderPlaylistList([{ id: 'p1', name: '通勤', songIds: ['a', 'b'] }]);
  assert.match(lists, /通勤（2 首）.*id=p1/);
  assert.equal(renderPlaylistList([]), '');
});

test('describeMusicValue：可读化各类值（错误消息里不出现 [object Object]）', () => {
  assert.equal(describeMusicValue('x'), '「x」');
  assert.equal(describeMusicValue(undefined), '（未给）');
  assert.equal(describeMusicValue(null), 'null');
  assert.equal(describeMusicValue({}), '对象');
  assert.equal(describeMusicValue([]), '数组');
  assert.equal(describeMusicValue(3), '3');
});

// ---------- 纯层：播完续接判定（后台连播的全部逻辑）----------

test('decideAfterFinish：四种播放方式的续接决策', () => {
  assert.deepEqual(decideAfterFinish({ playMode: 'stop', length: 3, currentIndex: 0 }), { kind: 'stop' });
  assert.deepEqual(decideAfterFinish({ playMode: 'repeatOne', length: 3, currentIndex: 1 }), { kind: 'seek0' });
  assert.deepEqual(decideAfterFinish({ playMode: 'sequential', length: 3, currentIndex: 0 }),
    { kind: 'next', index: 1 });
  // 顺序末尾接回第一首
  assert.deepEqual(decideAfterFinish({ playMode: 'sequential', length: 3, currentIndex: 2 }),
    { kind: 'next', index: 0 });
  const shuffled = decideAfterFinish({ playMode: 'shuffle', length: 3, currentIndex: 1 });
  assert.equal(shuffled.kind, 'next');
  assert.ok(shuffled.index >= 0 && shuffled.index < 3);
  assert.notEqual(shuffled.index, 1, '随机不该选回当前这首');
});

test('decideAfterFinish：边界与非法输入（空列表 / 未知模式）', () => {
  assert.deepEqual(decideAfterFinish({ playMode: 'sequential', length: 0, currentIndex: 0 }), { kind: 'stop' });
  assert.deepEqual(decideAfterFinish({ playMode: 'shuffle', length: 0, currentIndex: 0 }), { kind: 'stop' });
  // 未知模式按 stop 兜底（不抛、不乱切）
  assert.deepEqual(decideAfterFinish({ playMode: 'nonsense', length: 3, currentIndex: 0 }), { kind: 'stop' });
  // 单首：随机与顺序都只能回自己
  assert.deepEqual(decideAfterFinish({ playMode: 'shuffle', length: 1, currentIndex: 0 }),
    { kind: 'next', index: 0 });
  assert.deepEqual(decideAfterFinish({ playMode: 'sequential', length: 1, currentIndex: 0 }),
    { kind: 'next', index: 0 });
});

test('纯层既有判定不变（回归）：nextSequentialIndex / pickShuffleIndex', () => {
  assert.equal(nextSequentialIndex(3, 0), 1);
  assert.equal(nextSequentialIndex(3, 2), 0, '末首接回首');
  assert.equal(nextSequentialIndex(0, 0), -1);
  // 越界 index 被夹住
  assert.equal(nextSequentialIndex(3, 99), 0);
  assert.equal(pickShuffleIndex(1, 0), 0);
  assert.equal(pickShuffleIndex(0, 0), -1);
  // 固定随机源可预测：roll 取 0 时若 current=0 则跳过当前选 1
  assert.equal(pickShuffleIndex(3, 0, () => 0), 1);
});

// ---------- 工具形状与门控 ----------

test('工具形状：两个只读 + 一个写，且写工具**不声明**整工具级确认', () => {
  assert.deepEqual(MUSIC_READ_DEFINITIONS.map(i => i.name), ['list_music_library', 'get_music_status']);
  assert.deepEqual(MUSIC_WRITE_DEFINITIONS.map(i => i.name), ['control_music']);
  assert.equal(byName('list_music_library').readOnly, true);
  assert.equal(byName('get_music_status').readOnly, true);
  assert.equal(byName('control_music').readOnly, false);
  // ⚠️ 关键设计：control_music **不能**声明 requiresConfirmation。
  // 因为确认分级是「同一工具里 play/resume 弹、pause/next 不弹」，
  // 而 registry 的 requiresConfirmation 是**整工具级**的布尔——声明了会把
  // pause/next 也变成要弹（违背产品裁决），所以改由宿主按 action 分级。
  assert.equal(byName('control_music').requiresConfirmation, undefined,
    'control_music 不得声明整工具级确认（分级由 buildMusicApproval 按 action 决定）');
});

test('只读模式下 control_music 不出现在工具清单（canRunTool 口径）', () => {
  for (const definition of MUSIC_TOOL_DEFINITIONS) registerTool(definition);
  try {
    const readNames = listToolsForMode(AGENT_MODES.READ).map(i => i.function.name);
    const writeNames = listToolsForMode(AGENT_MODES.WRITE).map(i => i.function.name);
    assert.ok(readNames.includes('list_music_library'));
    assert.ok(readNames.includes('get_music_status'));
    assert.equal(readNames.includes('control_music'), false, '只读模式不得暴露 control_music');
    assert.ok(writeNames.includes('control_music'), '可改模式应能看到 control_music');
  } finally {
    for (const definition of MUSIC_TOOL_DEFINITIONS) unregisterTool(definition.name);
  }
});

// ---------- 确认分级的宿主接口 ----------

test('buildMusicApproval：play/resume 要确认并给出问句；其余动作 skip', () => {
  const play = buildMusicApproval({ action: 'play', trackName: '晴天' });
  assert.equal(play.kind, 'confirm');
  assert.match(play.text, /晴天/);

  const resume = buildMusicApproval({ action: 'resume', trackName: '稻香' });
  assert.equal(resume.kind, 'confirm');
  assert.match(resume.text, /稻香/);

  for (const action of ['pause', 'stop', 'next', 'prev', 'seek', 'set_rate', 'set_play_mode']) {
    assert.equal(buildMusicApproval({ action, args: {} }).kind, 'skip', `${action} 不该要确认`);
  }
});

test('buildMusicApproval：非法动作不因「不需要确认」而被放行（交工具自己拒）', () => {
  // skip 表示「不需要人工确认」，但**不等于**放行执行——工具 execute 里还有一层
  // validateMusicAction。这里断言：非法动作拿到的也是 skip（不打扰用户），
  // 由工具返回具体原因。若哪天误把非法动作判成 confirm，用户会被无谓地打扰。
  const bad = buildMusicApproval({ action: 'explode' });
  assert.equal(bad.kind, 'skip');
  // 但工具必须真的拒掉它（下一条用例验）。
});

// ---------- 脏层行为（storage / playerService 全打桩）----------

// 为什么必须注入：control_music 真跑起来会加载 music/library.js（→ AsyncStorage）
// 与 music/playerService.js（→ expo-audio），纯 Node 都 import 不了；
// 而工具层内部的 `require` 在 Node ESM 里根本不存在（Metro/CJS 才有）。
// 所以走工具层提供的 __setMusicNativeModules 注入点。
//
// ⚠️ 这条也是**被测的契约**：execute 必须经 native() 取模块，不能各自 require——
// 否则注入失效、测试会以「require is not defined」崩（我第一次就是这么写的）。
const nativeStubs = {
  library: { getMusicItems: async () => [] },
  playlists: { getMusicPlaylists: async () => [] },
  playerService: {
    snapshot: () => ({ current: null, status: {}, playMode: 'stop', rate: 1, queueLength: 0, remaining: 0 }),
    setQueue: () => 0,
    playAt: () => null,
    play: () => {},
    pause: () => {},
    stop: () => {},
    seekToSeconds: async () => {},
    setRate: value => value,
    setPlayMode: mode => mode,
    currentIndex: () => 0,
  },
};
const restoreNative = __setMusicNativeModules(nativeStubs);

function resetStubs() {
  nativeStubs.library.getMusicItems = async () => [];
  nativeStubs.playlists.getMusicPlaylists = async () => [];
  nativeStubs.playerService.snapshot = () => ({
    current: null, status: {}, playMode: 'stop', rate: 1, queueLength: 0, remaining: 0,
  });
  nativeStubs.playerService.setQueue = () => 0;
  nativeStubs.playerService.playAt = () => null;
  nativeStubs.playerService.play = () => {};
  nativeStubs.playerService.pause = () => {};
  nativeStubs.playerService.stop = () => {};
  nativeStubs.playerService.seekToSeconds = async () => {};
  nativeStubs.playerService.setRate = value => value;
  nativeStubs.playerService.setPlayMode = mode => mode;
  nativeStubs.playerService.currentIndex = () => 0;
}

test('空曲库：如实指路导入，**不假装修放成功**（任务书 P0-2 第 4 条）', async () => {
  resetStubs();
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'play' }, {});
  assert.match(out, /曲库为空/);
  assert.match(out, /未播放任何内容/, '必须明确说没播');
  // 不得出现「已开始播放」这类成功措辞
  assert.equal(out.includes('开始播放《'), false);
  // 指路要说清去哪导入
  assert.match(out, /扩展/, '要指路到导入入口');
});

test('曲库为空时 list_music_library 也如实指路（不返回空成功）', async () => {
  resetStubs();
  const tool = byName('list_music_library');
  const out = await tool.execute({}, {}, {});
  assert.match(out, /曲库为空/);
  assert.match(out, /扩展 → 内容库 → 音乐/);
});

test('play：给出不存在的 trackId → 如实报错并列出可用曲目，不播放', async () => {
  resetStubs();
  let played = false;
  nativeStubs.library.getMusicItems = async () => [
    { id: 't1', name: '晴天', uri: 'file://a.mp3', durationMs: 1000 },
  ];
  nativeStubs.playerService.playAt = () => { played = true; return { id: 't1', name: '晴天' }; };
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'play', trackId: 'nope' }, {});
  assert.match(out, /没有 id=nope 的曲目/);
  assert.match(out, /未播放任何内容/);
  assert.match(out, /晴天/, '要列出现有曲目让模型纠正');
  assert.equal(played, false, '目标不存在时绝不许播放');
});

test('play：歌单里歌曲全被删 → 如实报错，不塞幽灵条目进队列', async () => {
  resetStubs();
  let queued = null;
  nativeStubs.library.getMusicItems = async () => [];
  nativeStubs.playlists.getMusicPlaylists = async () => [
    { id: 'p1', name: '通勤', songIds: ['gone1', 'gone2'] },
  ];
  nativeStubs.playerService.setQueue = items => { queued = items; return items.length; };
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'play', playlistId: 'p1' }, {});
  assert.match(out, /没有可播放的曲目/);
  assert.match(out, /未播放任何内容/);
  assert.equal(queued, null, '空歌单不得入队');
});

test('play：正常路径 —— 曲目入队并从第一首起播', async () => {
  resetStubs();
  const queueSeen = [];
  let playedIndex = -1;
  nativeStubs.library.getMusicItems = async () => [
    { id: 't1', name: '晴天', uri: 'file://a.mp3', durationMs: 1000 },
    { id: 't2', name: '稻香', uri: 'file://b.mp3', durationMs: 2000 },
  ];
  nativeStubs.playerService.setQueue = items => { queueSeen.push(items); return items.length; };
  nativeStubs.playerService.playAt = index => {
    playedIndex = index;
    return { id: 't1', name: '晴天' };
  };
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'play', trackId: 't1' }, {});
  assert.equal(queueSeen.length, 1, '必须把队列交给服务');
  assert.equal(queueSeen[0].length, 1, '放单曲 = 队列只含这一首');
  assert.equal(playedIndex, 0, '从第一首起播');
  assert.match(out, /开始播放《晴天》/);
});

test('play：放歌单 = 歌单顺序入队（按 songIds 过滤后）', async () => {
  resetStubs();
  const queueSeen = [];
  nativeStubs.library.getMusicItems = async () => [
    { id: 't1', name: 'A', uri: 'file://a.mp3', durationMs: 1 },
    { id: 't2', name: 'B', uri: 'file://b.mp3', durationMs: 1 },
    { id: 't3', name: 'C', uri: 'file://c.mp3', durationMs: 1 },
  ];
  nativeStubs.playlists.getMusicPlaylists = async () => [
    { id: 'p1', name: '通勤', songIds: ['t2', 't1'] },
  ];
  nativeStubs.playerService.setQueue = items => { queueSeen.push(items); return items.length; };
  nativeStubs.playerService.playAt = () => ({ id: 't2', name: 'B' });
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'play', playlistId: 'p1' }, {});
  assert.equal(queueSeen[0].length, 2);
  assert.deepEqual(queueSeen[0].map(i => i.id), ['t2', 't1'], '按歌单里的顺序入队');
  assert.match(out, /歌单《通勤》（共 2 首）/);
});

test('resume：没有当前曲目时如实说，不假装续上了', async () => {
  resetStubs();
  const tool = byName('control_music');
  const out = await tool.execute({}, { action: 'resume' }, {});
  assert.match(out, /没有可继续播放的曲目/);
  assert.match(out, /play/);
});

test('next：没有在播放时如实说；在播放时切下一首', async () => {
  resetStubs();
  const tool = byName('control_music');
  const idle = await tool.execute({}, { action: 'next' }, {});
  assert.match(idle, /没有在播放/);

  nativeStubs.playerService.snapshot = () => ({
    current: { id: 't1', name: '晴天' }, status: {}, playMode: 'sequential', rate: 1, queueLength: 3, remaining: 2,
  });
  nativeStubs.playerService.currentIndex = () => 0;
  let target = -1;
  nativeStubs.playerService.playAt = index => { target = index; return { id: 't2', name: '稻香' }; };
  const out = await tool.execute({}, { action: 'next' }, {});
  assert.equal(target, 1, '顺序下一首');
  assert.match(out, /下一首《稻香》/);
});

test('set_rate / set_play_mode：透传给服务并如实回报', async () => {
  resetStubs();
  const tool = byName('control_music');
  nativeStubs.playerService.setRate = value => value;
  nativeStubs.playerService.setPlayMode = mode => mode;
  assert.match(await tool.execute({}, { action: 'set_rate', rate: 1.5 }, {}), /倍速已设为 1\.5x/);
  assert.match(await tool.execute({}, { action: 'set_play_mode', playMode: 'sequential' }, {}),
    /播放方式已设为 sequential/);
});

test('每个动作都有实现（键级对账：白名单与 execute 分支不漏不余）', async () => {
  resetStubs();
  // 用「非法参数拒绝 + 合法参数不返回未知动作」两面夹逼：
  // 若某个动作在 execute 里没有分支，它会掉到最后的「未知动作」兜底。
  nativeStubs.library.getMusicItems = async () => [
    { id: 't1', name: 'A', uri: 'file://a.mp3', durationMs: 1 },
  ];
  nativeStubs.playerService.snapshot = () => ({
    current: { id: 't1', name: 'A' }, status: {}, playMode: 'stop', rate: 1, queueLength: 1, remaining: 0,
  });
  nativeStubs.playerService.playAt = () => ({ id: 't1', name: 'A' });
  const tool = byName('control_music');
  const argsFor = {
    play: { action: 'play', trackId: 't1' },
    pause: { action: 'pause' },
    resume: { action: 'resume' },
    stop: { action: 'stop' },
    next: { action: 'next' },
    prev: { action: 'prev' },
    seek: { action: 'seek', positionSeconds: 10 },
    set_rate: { action: 'set_rate', rate: 1 },
    set_play_mode: { action: 'set_play_mode', playMode: 'stop' },
  };
  for (const action of MUSIC_ACTION_NAMES) {
    const out = await tool.execute({}, argsFor[action], {});
    assert.equal(out.includes('未知动作'), false, `${action} 在 execute 里没有分支`);
    assert.equal(out.includes('未做任何操作'), false, `${action} 的参数被自己拒了（argsFor 写错？）`);
  }
  // 同时确认白名单与对账表一一对应（加了动作忘了写 argsFor 会在这里露）
  assert.deepEqual(Object.keys(argsFor).sort(), [...MUSIC_ACTION_NAMES].sort());
});

test('诊断留痕：每个动作都调 noteMusicTool（action + 目标名）', async () => {
  resetStubs();
  const calls = [];
  setMusicToolRecorder({ noteMusicTool: (action, target) => calls.push(`${action}:${target}`) });
  try {
    nativeStubs.library.getMusicItems = async () => [{ id: 't1', name: '晴天', uri: 'file://a.mp3', durationMs: 1 }];
    nativeStubs.playerService.playAt = () => ({ id: 't1', name: '晴天' });
    const tool = byName('control_music');
    await tool.execute({}, { action: 'play', trackId: 't1' }, {});
    assert.ok(calls.some(item => item === 'play:晴天'), 'play 要打点目标名');
    // 空曲库单独打点（任务书 P1-3）
    resetStubs();
    calls.length = 0;
    await tool.execute({}, { action: 'play' }, {});
    assert.ok(calls.includes('play:empty-library'), '空曲库要单独打点');
  } finally {
    setMusicToolRecorder(null);
  }
});

// ---------- 结构守卫（P1-4 第三条）----------

test('结构：播放器只许在 playerService 一处创建（页面/hook 都不许）', () => {
  for (const rel of ['src/music/useMusicPlayer.js', 'src/music/MusicScreen.js']) {
    const source = read(rel);
    assert.equal(/createAudioPlayer/.test(source), false,
      `${rel} 不得直接 createAudioPlayer（只许 playerService 一处）`);
  }
  const service = read('src/music/playerService.js');
  assert.ok(service.includes('createAudioPlayer'), 'playerService 是唯一创建点');
  // 队列语义也必须在服务里（页面不在场时也要能续接）
  assert.ok(service.includes('decideAfterFinish'), '续接判定在服务里');
  assert.ok(service.includes('export function setQueue'), '队列由服务持有');
});

test('结构：useMusicPlayer 是订阅适配层（卸载不销毁播放）', () => {
  const hook = read('src/music/useMusicPlayer.js');
  // 剥注释再判：这个文件的注释正解释着「为什么**不** release / remove」，
  // 按整文件匹配会自己打自己（本仓反复踩过的假阳性形态）。
  const code = hook.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.ok(code.includes('playerService.subscribe'), '订阅服务');
  // 关键：卸载只退订，**不得** release/remove 播放器（那是本轮修的根因）
  assert.equal(/playerService\.release/.test(code), false, 'hook 卸载不得释放播放器');
  assert.equal(/\.remove\(\)/.test(code), false, 'hook 里不得 remove 播放器');
});

test('结构：MusicScreen 不再自己处理播完续接（否则后台连播会断）', () => {
  const screen = read('src/music/MusicScreen.js');
  assert.equal(screen.includes('finishedHandledRef'), false,
    '页面不得再自行处理播完续接（那是本轮修的根因）');
  assert.ok(screen.includes('playerService.setQueue'), '页面把队列同步给服务');
  // 页面仍要有状态同步（服务自动换歌时页面跟着变）
  assert.ok(screen.includes('playerService'), '页面通过 playerService 交互');
});

// 还原注入，避免污染同进程后续测试。
test.after(() => {
  restoreNative();
});
