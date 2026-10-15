// FEAT-AC2：音乐工具域的**纯逻辑层**（零 RN 依赖，Node 直测）。
//
// 与 FEAT-AC1 的 appSettingsSchema.js 同一套纪律：值域、动作白名单、**确认分级**、
// 参数校验、文案渲染留在纯层；读写存储与播放器留在脏层（musicTools.js）。
//
// 为什么这一层特别值得拆：**确认分级**是本次唯一的产品裁决（会出声的动作才弹确认），
// 而它恰好是纯判定——抽出来就能把「哪些动作弹、哪些不弹」全测一遍，
// 不必真机点。若混进脏层，这条规则就只能靠 review 守。

import { MUSIC_PLAY_MODES, MUSIC_RATES } from '../music/playerSettingsPure.js';
import { describeValue } from './schemaValue.js';

// 与 AC1 的 describeValue 共用同一实现（口径统一，避免三处漂移）。
export const describeMusicValue = describeValue;

/**
 * control_music 的动作白名单（**唯一事实源**）。
 *
 * `needsConfirm: true` = 会出声的动作 → 执行前弹确认（产品裁决：一条干净规则）。
 * 其余是「静音化或轻调整」：用户话音刚落就要暂停，再弹窗反而挡路。
 */
export const MUSIC_ACTIONS = Object.freeze({
  play: Object.freeze({ needsConfirm: true, describe: `开始播放` }),
  resume: Object.freeze({ needsConfirm: true, describe: `继续播放` }),
  pause: Object.freeze({ needsConfirm: false, describe: `暂停` }),
  stop: Object.freeze({ needsConfirm: false, describe: `停止` }),
  next: Object.freeze({ needsConfirm: false, describe: `下一首` }),
  prev: Object.freeze({ needsConfirm: false, describe: `上一首` }),
  seek: Object.freeze({ needsConfirm: false, describe: `跳到指定位置` }),
  set_rate: Object.freeze({ needsConfirm: false, describe: `设置倍速` }),
  set_play_mode: Object.freeze({ needsConfirm: false, describe: `设置播放方式` }),
});

export const MUSIC_ACTION_NAMES = Object.freeze(Object.keys(MUSIC_ACTIONS));

/** 动作是否需要用户确认。白名单外一律 false（调用方本该先拒掉，这是兜底）。 */
export function actionNeedsConfirm(action) {
  const spec = MUSIC_ACTIONS[action];
  return !!(spec && spec.needsConfirm);
}

/** 需要确认的动作清单（给测试与文档用，从同一张表派生）。 */
export const MUSIC_CONFIRM_ACTIONS = Object.freeze(
  MUSIC_ACTION_NAMES.filter(name => MUSIC_ACTIONS[name].needsConfirm)
);

/**
 * 校验 control_music 的参数。
 *
 * 返回 null = 通过；返回字符串 = 拒绝原因。
 * **存在性校验（trackId/playlistId 是否真的存在）不在这里**——那要读盘，属脏层。
 * 这里只管「形状与值域」：缺参数、动作不认、倍速/播放方式不合法。
 */
export function validateMusicAction(action, args = {}) {
  const name = String(action || '').trim();
  if (!name) return `缺少 action（可用：${MUSIC_ACTION_NAMES.join(' / ')}）`;
  if (!MUSIC_ACTIONS[name]) {
    return `未知动作「${name}」。可用动作：${MUSIC_ACTION_NAMES.join(' / ')}`;
  }
  const source = args && typeof args === 'object' ? args : {};
  if (name === 'play') {
    const trackId = String(source.trackId || '').trim();
    const playlistId = String(source.playlistId || '').trim();
    // 两个都不给 = 「随便放一首」：**有意允许**（用户只说「放首歌」时助手不该被逼着先查库）。
    // 但两个都给是歧义，拒绝并要求澄清（比猜一个更诚实）。
    if (trackId && playlistId) {
      return `trackId 与 playlistId 只能给一个（决定放单曲还是整个歌单）`;
    }
  }
  if (name === 'seek') {
    const seconds = Number(source.positionSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return `seek 需要 positionSeconds（≥ 0 的数字），收到的是 ${describeMusicValue(source.positionSeconds)}`;
    }
  }
  if (name === 'set_rate') {
    const rate = Number(source.rate);
    if (!MUSIC_RATES.includes(rate)) {
      return `倍速只能是 ${MUSIC_RATES.join(' / ')} 之一，收到的是 ${describeMusicValue(source.rate)}`;
    }
  }
  if (name === 'set_play_mode') {
    const mode = String(source.playMode || '').trim();
    if (!MUSIC_PLAY_MODES.includes(mode)) {
      return `播放方式只能是 ${MUSIC_PLAY_MODES.join(' / ')} 之一，收到的是 ${describeMusicValue(source.playMode)}`;
    }
  }
  return null;
}

/** 动作的可读名（结果文本里用）。 */
export function describeMusicAction(action) {
  const spec = MUSIC_ACTIONS[action];
  return spec ? spec.describe : String(action || '');
}

/** 毫秒 → "3:05"（工具输出给模型看，与界面口径一致）。 */
export function formatMusicDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 渲染确认弹窗要问的话（play / resume 用）。
 *
 * 产品裁决的文案要求是「将开始播放《歌名》」——本函数按这个口径产出。
 * ⚠️ 与 AC1 同样：**真正的弹窗文案由 UI 层渲染**（本仓审批弹窗走 i18n 标题 +
 * JSON args，见 src/chat/toolApproval.js）。本函数产出的是给**模型**看的说明，
 * 以及供工具输出复用的一句话。
 */
export function renderMusicConfirmText({ action, trackName, playlistName, count } = {}) {
  const name = String(trackName || '').trim();
  const list = String(playlistName || '').trim();
  if (action === 'resume') return `将继续播放${name ? `《${name}》` : '当前曲目'}，允许吗？`;
  if (list) {
    const suffix = Number.isFinite(count) && count > 0 ? `（${count} 首）` : '';
    return `将开始播放歌单《${list}》${suffix}，允许吗？`;
  }
  if (name) return `将开始播放《${name}》，允许吗？`;
  return `将开始播放音乐（随机曲目），允许吗？`;
}

/** 曲目列表的渲染（list_music_library 用）：一行一首，带 id、名称、时长。 */
export function renderTrackList(items, { limit = 50 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '';
  return list.slice(0, limit).map(item => {
    const duration = Number(item.durationMs) > 0 ? `（${formatMusicDuration(item.durationMs)}）` : '';
    return `- ${item.name}${duration}　id=${item.id}`;
  }).join('\n');
}

/** 歌单列表的渲染：一行一个，带曲目数。 */
export function renderPlaylistList(playlists, { limit = 30 } = {}) {
  const list = Array.isArray(playlists) ? playlists : [];
  if (list.length === 0) return '';
  return list.slice(0, limit).map(item => {
    const count = Array.isArray(item.songIds) ? item.songIds.length : 0;
    return `- ${item.name}（${count} 首）　id=${item.id}`;
  }).join('\n');
}
