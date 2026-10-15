// FEAT-AC2：音乐工具域（list_music_library / get_music_status / control_music）。
//
// 用户诉求：悬浮窗里说「放首歌」，助手应该真的去放，而不是回答
// 「曲库里没有音乐文件」「你去 扩展→内容库→音乐 自己找」。
//
// 为什么此前放不了（本轮立项的根因，已对码核实）：播放器活在一个 hook 的 useRef 里，
// 而那个 hook 全仓唯一使用点是 MusicScreen——**播放器随音乐页生灭**。
// 人在别的页面/别的 app（悬浮窗的主场景）时根本没有播放器实例，工具驱动不了。
// P0-1 已把播放器与队列搬进 src/music/playerService.js 单例，本文件才有的可驱动。
//
// 分层（照抄 FEAT-AC1 的纪律）：
//   · musicToolSchema.js（纯层）—— 动作白名单、确认分级、参数校验、文案渲染；
//   · 本文件（脏层）—— 读存储 / contact playerService / 工具定义；
//   · storage 与 playerService 用**惰性 require**（先例 appSettingsTools.js:42）：
//     它们依赖 expo-file-system / expo-audio，静态 import 会让
//     「读工具定义」这一步就把整批 import tools.js 的测试拖崩。

import {
  MUSIC_ACTIONS,
  MUSIC_ACTION_NAMES,
  actionNeedsConfirm,
  formatMusicDuration,
  renderMusicConfirmText,
  renderPlaylistList,
  renderTrackList,
  validateMusicAction,
} from '../musicToolSchema.js';
// 纯层（零依赖）可以静态 import —— 只有碰原生模块的才需要惰性 require。
import { nextSequentialIndex } from '../../music/playerSettingsPure.js';

// 惰性加载原生依赖（见文件头说明）。
//
// ⚠️ 这里用 require（Metro/CJS 运行时可用），但**纯 Node ESM 里没有 require**——
// 所以下面额外提供 __setMusicNativeModules 注入点，让单测能把这三个模块换成桩
//（FEAT-AC1 的 appSettingsTools 用 __swapPanelReaders 解决同一问题；那边测试
//  从不真的走到 storage()，这边 execute 一定会走到 native()，注入点是必需的）。
let nativeModules = null;
function native() {
  if (!nativeModules) {
    nativeModules = {
      library: require('../../music/library.js'),
      playlists: require('../../music/playlists.js'),
      playerService: require('../../music/playerService.js'),
    };
  }
  return nativeModules;
}

/**
 * 注入原生依赖（**仅测试用**，也可给「宿主想换实现」的场景）。
 * 传 null 恢复为惰性 require。返回还原函数。
 */
export function __setMusicNativeModules(modules) {
  const backup = nativeModules;
  nativeModules = modules || null;
  return () => { nativeModules = backup; };
}

// 诊断留痕的**注入点**：诊断模块依赖 AsyncStorage，纯 Node 单测不该被拖进来。
let musicTrace = { noteMusicTool() {} };

/** 替换诊断留痕实现（宿主 / 测试注入）。 */
export function setMusicToolRecorder(recorder) {
  musicTrace = recorder || { noteMusicTool() {} };
}

/**
 * 解析 play 的目标：单曲 / 歌单 / 都没有（随机全库）。
 *
 * 返回 { items, label, count } 或 { error }。
 * **存在性校验在这里**（要读盘），形状校验在纯层。
 */
async function resolvePlayTarget({ trackId, playlistId }) {
  const { library, playlists } = native();
  let items = [];
  try {
    items = await library.getMusicItems();
  } catch (error) {
    return { error: `读取曲库失败：${String((error && error.message) || error)}` };
  }
  const all = Array.isArray(items) ? items : [];
  const wantedTrack = String(trackId || '').trim();
  const wantedList = String(playlistId || '').trim();

  if (wantedTrack) {
    const hit = all.find(item => item.id === wantedTrack);
    if (!hit) {
      // 存在性失败要**如实说**，并给出可选清单（让模型自己纠正，而不是猜）。
      return {
        error: `曲库里没有 id=${wantedTrack} 的曲目，未播放。可用曲目：\n${renderTrackList(all, { limit: 20 })}`,
      };
    }
    return { items: [hit], label: hit.name, count: 1 };
  }

  if (wantedList) {
    let lists = [];
    try {
      lists = await playlists.getMusicPlaylists();
    } catch (error) {
      return { error: `读取歌单失败：${String((error && error.message) || error)}` };
    }
    const list = (Array.isArray(lists) ? lists : []).find(item => item.id === wantedList);
    if (!list) {
      return {
        error: `没有 id=${wantedList} 的歌单，未播放。可用歌单：\n${renderPlaylistList(lists)}`,
      };
    }
    const songIds = Array.isArray(list.songIds) ? list.songIds : [];
    // 歌单里的 id 可能已失效（歌曲被删）：按曲库过滤，别把幽灵条目塞进队列。
    const picked = songIds.map(id => all.find(item => item.id === id)).filter(Boolean);
    if (picked.length === 0) {
      return { error: `歌单《${list.name}》里没有可播放的曲目（歌曲可能已被删除），未播放。` };
    }
    return { items: picked, label: list.name, count: picked.length, isPlaylist: true };
  }

  // 两个都没给：放整个曲库（从第一首起，后续按 playMode 续接）。
  if (all.length === 0) return { error: '曲库为空' };
  return { items: all, label: '', count: all.length };
}

const LIST_MUSIC_LIBRARY_TOOL = {
  name: 'list_music_library',
  description: '列出音乐曲库与歌单（只读）。曲目给出 id / 名称 / 时长，歌单给出 id / 名称 / 曲目数。'
    + '「放首歌」之前可用它选目标；曲目为空时如实说明并指路「扩展 → 内容库 → 音乐」导入。',
  readOnly: true,
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const { library, playlists } = native();
    let items = [];
    let lists = [];
    try {
      items = await library.getMusicItems();
    } catch (error) {
      return `读取曲库失败：${String((error && error.message) || error)}`;
    }
    try {
      lists = await playlists.getMusicPlaylists();
    } catch (error) {
      // 歌单读失败不影响曲库展示（两件事分开如实说）。
      lists = null;
    }
    const trackList = Array.isArray(items) ? items : [];
    if (trackList.length === 0) {
      // 任务书 P0-2 明确要求：空曲库如实指路，**不得假装修放成功**。
      return '曲库为空。请先在 App 的「扩展 → 内容库 → 音乐」里导入音乐文件，之后我才能播放。';
    }
    const body = renderTrackList(trackList);
    const playlistBody = lists === null
      ? '（歌单读取失败，本次未列出）'
      : (renderPlaylistList(lists) || '（还没有歌单）');
    return `曲库共 ${trackList.length} 首：\n${body}\n\n歌单：\n${playlistBody}`;
  },
};

const GET_MUSIC_STATUS_TOOL = {
  name: 'get_music_status',
  description: '查询当前音乐播放状态（只读）：正在放什么、播放到第几秒、播放方式、倍速、队列余量。'
    + '没有在播放时如实说明。',
  readOnly: true,
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const { playerService } = native();
    const snap = playerService.snapshot();
    const current = snap && snap.current;
    if (!current) return '当前没有在播放音乐。';
    const status = (snap && snap.status) || {};
    const position = formatMusicDuration(status.positionMs);
    const duration = Number(status.durationMs) > 0 ? formatMusicDuration(status.durationMs) : '未知';
    const playing = status.playing ? '正在播放' : '已暂停';
    return `${playing}《${current.name}》，进度 ${position} / ${duration}，`
      + `播放方式 ${snap.playMode}，倍速 ${snap.rate}x，队列还有 ${snap.remaining} 首。`;
  },
};

const CONTROL_MUSIC_TOOL = {
  name: 'control_music',
  description: '控制音乐播放。这是写操作（会改变正在播放的内容）。'
    + '`play` 与 `resume` **执行前会弹确认框让用户批准**（它们会出声）；'
    + '`pause` / `stop` / `next` / `prev` / `seek` / `set_rate` / `set_play_mode` 不弹（静音化或轻调整）。'
    + `动作与参数：play（可选 trackId 或 playlistId，都不给=整个曲库随机起播）、`
    + `pause、resume、stop、next、prev、seek（positionSeconds）、`
    + `set_rate（rate ∈ ${'0.5 / 0.75 / 1 / 1.5 / 2'}）、`
    + `set_play_mode（playMode ∈ stop / repeatOne / sequential / shuffle）。`
    + '曲库为空时如实说明并指路导入，不要假装修放。',
  // 写工具：只在「可改」模式出现（canRunTool 按 readOnly 过滤）。
  readOnly: false,
  // ⚠️ requiresConfirmation 这里**不能**一律设 true：确认分级是产品裁决
  //（只有 play/resume 弹），而 registry 的 requiresConfirmation 是**整工具**级的。
  // 所以本工具不声明它，改由宿主侧的审批钩子按 action 分级——
  // 那份判定的**唯一事实源**是 musicToolSchema 的 MUSIC_ACTIONS.needsConfirm，
  // 由 buildMusicApproval 暴露给宿主（见文件末尾）。
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: `动作，取值 ${MUSIC_ACTION_NAMES.join(' / ')}。`,
      },
      trackId: { type: 'string', description: 'play 专用：要播放的曲目 id（与 playlistId 二选一）。' },
      playlistId: { type: 'string', description: 'play 专用：要播放的歌单 id（与 trackId 二选一）。' },
      positionSeconds: { type: 'number', description: 'seek 专用：跳到第几秒。' },
      rate: { type: 'number', description: 'set_rate 专用：倍速档位。' },
      playMode: { type: 'string', description: 'set_play_mode 专用：播放方式。' },
    },
    required: ['action'],
  },
  execute: async (options, args) => {
    const action = String((args && args.action) || '').trim();
    const invalid = validateMusicAction(action, args || {});
    if (invalid) return `${invalid}。未做任何操作。`;
    const { playerService } = native();

    if (action === 'play') {
      const target = await resolvePlayTarget({
        trackId: args.trackId,
        playlistId: args.playlistId,
      });
      if (target.error) {
        // 空曲库单独打点（任务书 P1-3）：它是最常见的失败，值得在诊断里一眼看到。
        if (target.error === '曲库为空') {
          musicTrace.noteMusicTool('play', 'empty-library');
          return '曲库为空。请先在 App 的「扩展 → 内容库 → 音乐」里导入音乐文件。未播放任何内容。';
        }
        musicTrace.noteMusicTool('play', 'target-missing');
        return `${target.error}。未播放任何内容。`;
      }
      playerService.setQueue(target.items);
      // 放歌单/全库时从第一首起播（后续按 playMode 自动续接）。
      const played = playerService.playAt(0);
      musicTrace.noteMusicTool('play', target.label || `library(${target.count})`);
      if (!played) return '播放未能启动（队列为空），未播放任何内容。';
      const scope = target.isPlaylist ? `歌单《${target.label}》（共 ${target.count} 首）` : `《${played.name}》`;
      return `开始播放${scope}。`;
    }

    if (action === 'pause') {
      playerService.pause();
      musicTrace.noteMusicTool('pause', currentName(playerService));
      return '已暂停。';
    }

    if (action === 'resume') {
      // resume 必须**真的有东西可续**：没有当前曲目时如实说，不要假装续上了。
      const snap = playerService.snapshot();
      if (!snap || !snap.current) return '当前没有可继续播放的曲目（先用 play 开始播放）。';
      playerService.play();
      musicTrace.noteMusicTool('resume', snap.current.name);
      return `已继续播放《${snap.current.name}》。`;
    }

    if (action === 'stop') {
      playerService.stop();
      musicTrace.noteMusicTool('stop', currentName(playerService));
      return '已停止播放。';
    }

    if (action === 'next') {
      const snap = playerService.snapshot();
      if (!snap || !snap.current) return '当前没有在播放，无法切到下一首。';
      // 顺序下一首（末首接回第一首）——与界面「下一首」按钮同一口径。
      const index = playerService.currentIndex();
      const played = playerService.playAt(nextSequentialIndex(snap.queueLength, index));
      musicTrace.noteMusicTool('next', played ? played.name : 'none');
      return played ? `已切到下一首《${played.name}》。` : '无法切换（队列为空）。';
    }

    if (action === 'prev') {
      const snap = playerService.snapshot();
      if (!snap || !snap.current) return '当前没有在播放，无法切到上一首。';
      const index = playerService.currentIndex();
      const played = playerService.playAt(index - 1);
      musicTrace.noteMusicTool('prev', played ? played.name : 'none');
      return played ? `已切到上一首《${played.name}》。` : '无法切换（队列为空）。';
    }

    if (action === 'seek') {
      const seconds = Number(args.positionSeconds);
      const snap = playerService.snapshot();
      if (!snap || !snap.current) return '当前没有在播放，无法跳转。';
      await playerService.seekToSeconds(seconds);
      musicTrace.noteMusicTool('seek', `${Math.floor(seconds)}s`);
      return `已跳到 ${formatMusicDuration(seconds * 1000)}。`;
    }

    if (action === 'set_rate') {
      const applied = playerService.setRate(Number(args.rate));
      musicTrace.noteMusicTool('set_rate', `${applied}x`);
      return `倍速已设为 ${applied}x。`;
    }

    if (action === 'set_play_mode') {
      const applied = playerService.setPlayMode(String(args.playMode));
      musicTrace.noteMusicTool('set_play_mode', applied);
      return `播放方式已设为 ${applied}。`;
    }

    return `未知动作「${action}」。`;
  },
};

function currentName(playerService) {
  const snap = playerService.snapshot();
  return (snap && snap.current && snap.current.name) || 'none';
}

export const MUSIC_TOOL_DEFINITIONS = Object.freeze([
  LIST_MUSIC_LIBRARY_TOOL,
  GET_MUSIC_STATUS_TOOL,
  CONTROL_MUSIC_TOOL,
]);

// 按模式分组（索引层的聚合次序是契约：只读在前、写在写区）。
export const MUSIC_READ_DEFINITIONS = Object.freeze(
  MUSIC_TOOL_DEFINITIONS.filter(item => item.readOnly === true)
);
export const MUSIC_WRITE_DEFINITIONS = Object.freeze(
  MUSIC_TOOL_DEFINITIONS.filter(item => item.readOnly !== true)
);

/**
 * FEAT-AC2 确认分级的**宿主接口**。
 *
 * 为什么需要它：registry 的 `requiresConfirmation` 是整工具级的布尔，而产品裁决是
 * 「同一工具里 play/resume 要弹、pause/next 不弹」。所以 control_music **不声明**
 * requiresConfirmation，改由宿主的审批钩子调用本函数按 action 分级。
 *
 * 返回：
 *   { kind: 'skip' }                  —— 不需要确认，直接执行
 *   { kind: 'confirm', text }         —— 需要确认，text 是给用户看的问句
 *   { kind: 'reject', text }          —— 动作非法，直接拒绝（不打扰用户）
 *
 * ⚠️ skip 只在「动作合法且不需要确认」时返回。非法动作走 reject——
 * 不能因为「不需要确认」就把非法动作放行（那会让校验被绕过）。
 */
export function buildMusicApproval({ action, args, trackName, playlistName, count } = {}) {
  const name = String(action || '').trim();
  if (validateMusicAction(name, args || {})) {
    return { kind: 'skip' };   // 非法动作交给工具自己拒（那里有完整原因文案）
  }
  if (!actionNeedsConfirm(name)) return { kind: 'skip' };
  return {
    kind: 'confirm',
    text: renderMusicConfirmText({ action: name, trackName, playlistName, count }),
  };
}

/** 测试可见：供单测断言「每个动作都有实现」。 */
export const __musicToolNames = MUSIC_ACTION_NAMES;
export const __musicActions = MUSIC_ACTIONS;
