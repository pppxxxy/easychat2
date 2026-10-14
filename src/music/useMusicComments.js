// 一起听歌的角色评论 hook：打点/开场触发 → 组 prompt → 组装消息（可含歌曲音频片段）
// → 经 sendWithModelProvider 路由（本地多模态模型优先，失败回退在线）→ appendMusicComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求，新的触发在生成期间直接跳过（触发位已记 fired，
// 失败可从错误条重试，不会因跳过而永久丢失——重试走直调，不依赖 crossing）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { canUseLocalModel, sendWithModelProvider } from '../network/modelProvider.js';
import { buildRequestMessages, filterRequestMedia } from '../prompt/chatPipeline.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getUserProfile } from '../storage/personas.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import { getLocalModelFileInfo } from '../localModel/modelManager.js';

import { appendMusicComment, getMusicComments } from './comments.js';
import { readAudioFileBase64 } from './importMusic.js';
import {
  MUSIC_AUDIO_MAX_BYTES,
  MUSIC_DECODE_MAX_BYTES,
  buildOpeningCommentPrompt,
  buildTriggerCommentPrompt,
  canAttachSongAudio,
  resolveAudioSupport,
  resolveOnlineAudioSupport,
} from './commentPrompts.js';
import { CLIP_DURATION_MS, CLIP_SAMPLE_RATE } from './audioClip.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

// 读取歌曲文件为 base64（走 music 域的文件读取封装）。读盘失败返回 null。
async function readSongBase64(currentSong) {
  const song = currentSong && typeof currentSong === 'object' ? currentSong : {};
  const base64 = await readAudioFileBase64(song.uri);
  return base64 || null;
}

// 裁剪设置里的正数（毫秒 / 赫兹）：未配置、非数字、非正数一律归 0，调用方用 `|| 默认值` 兜底。
// 为什么不能写成 `Math.max(1, x) || 默认值`：Math.max(1, x) 恒 ≥ 1，右侧默认值**永远不可达**；
// 而真正没配置时（settings 为空）会被压成 1ms / 1Hz，而不是默认的 30 秒 / 16kHz。
// 把「无效」显式归 0，默认分支才真正生效。
function positiveOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

// 准备随评论发送的音频：优先用 WebView 裁剪出从 startMs 起的一段 WAV（体积小、
// 规避端点时长上限）；无法裁剪时退回整首原文件（仅当不超 25MB）。都不可用返回 null，
// 调用方退回纯文字评论（不阻断功能）。
export async function prepareSongAudioForModel(
  currentSong,
  clipAudio,
  { startMs = 0, durationMs = CLIP_DURATION_MS, sampleRate = CLIP_SAMPLE_RATE } = {}
) {
  const song = currentSong && typeof currentSong === 'object' ? currentSong : {};
  if (!canAttachSongAudio(song, MUSIC_DECODE_MAX_BYTES)) return null;
  const canClip = typeof clipAudio === 'function';
  // 裁剪路径读取整首解码；整首发送路径只在体积达标时读取。
  if (!canClip && !canAttachSongAudio(song, MUSIC_AUDIO_MAX_BYTES)) return null;
  const base64 = await readSongBase64(song);
  if (!base64) return null;
  if (canClip) {
    try {
      const clipped = await clipAudio({ base64, startMs, durationMs, sampleRate });
      if (clipped && clipped.base64) return { base64: clipped.base64, mime: clipped.mime || 'audio/wav' };
    } catch (error) {
      // 裁剪失败（编解码不支持等）→ 退回整首原始音频。
    }
  }
  if (canAttachSongAudio(song, MUSIC_AUDIO_MAX_BYTES)) {
    return { base64, mime: String(song.mime || '').trim() };
  }
  return null;
}

export function useMusicComments({ song, characters, defaultCharacterId = '', clipAudio = null, clipSettings = null }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 读路径（装载历史评论）的失败态，与生成失败**分开**记：两者的重试动作完全不同
  // （读失败 → 重新读盘；生成失败 → 重发请求），合成一个状态就分不清该重试什么。
  // 存布尔而不是文案：文案在返回时按当前语言现翻，切语言后错误条也跟着变。
  const [commentsReadFailed, setCommentsReadFailed] = useState(false);
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));
  // null = 能力未知（尚未读出配置）；false = 当前来源不具备听音频能力。
  const [audioSupported, setAudioSupported] = useState(null);
  const { t } = useTranslation();

  const songRef = useRef(song);
  songRef.current = song;
  // 换歌/装载的竞态判据：await 回来后用它确认「还是同一首歌」，避免旧请求覆盖新歌。
  const songId = song ? song.id : '';
  const songIdRef = useRef(songId);
  songIdRef.current = songId;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;
  const clipAudioRef = useRef(clipAudio);
  clipAudioRef.current = clipAudio;
  const clipSettingsRef = useRef(clipSettings);
  clipSettingsRef.current = clipSettings;
  const generatingRef = useRef(false);
  const abortRef = useRef(null);
  const lastFailedRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // 装载当前歌的历史评论。读失败**不再吞掉**：以前 `.catch(() => {})` 把失败演成
  // 「空列表」，面板于是显示「还没有评论」，用户以为评论丢了（数据其实还在存储里）。
  // 现在把失败如实标出来（commentsReadFailed），并且**不清空已装载的评论**——读不到
  // 不等于没有；换歌时才由下面的 effect 清空（那是「换了一首歌」，不是「读失败」）。
  const loadComments = useCallback(async () => {
    const targetId = songIdRef.current;
    if (!targetId) return false;
    try {
      const list = await getMusicComments(targetId);
      // 装载期间换了歌（或已卸载）：本次结果作废，effect 会为新歌重新装载。
      if (!mountedRef.current || songIdRef.current !== targetId) return false;
      setComments(list);
      setCommentsReadFailed(false);
      return true;
    } catch (caught) {
      if (!mountedRef.current || songIdRef.current !== targetId) return false;
      setCommentsReadFailed(true);
      return false;
    }
  }, []);

  // 换歌：中断在途生成、重置错误与重试位，并装载新歌的历史评论。
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    setError('');
    setCommentsReadFailed(false);
    lastFailedRef.current = null;
    setComments([]);
    if (!songId) return undefined;
    loadComments();
    return undefined;
  }, [songId, loadComments]);

  // 音频能力探测：面板打开/切歌时读一次在线配置与本地模型能力，供「听不到音频」提示。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getApiConfigs().catch(() => null),
      getLocalModelSettings().catch(() => null),
      getActiveLocalModel().catch(() => null),
    ]).then(([apiConfig, localSettings, localItem]) => {
      if (cancelled) return;
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      setAudioSupported(resolveAudioSupport(apiConfig, localMedia));
    });
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const generate = useCallback(async ({ kind, atMs = 0, note = '', song: songOverride = null }) => {
    // 显式传入目标歌时以它为准：切歌是「setCurrentId 后同步调用」，此刻 songRef 还指向上一首
    // （render 期才赋值），不传就会把开场评论写到旧歌上。
    const currentSong = songOverride || songRef.current;
    if (!currentSong || generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      setError(t('music.error.noCharacter'));
      return false;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    try {
      const [profile, presets, apiConfig, localSettings, localItem] = await Promise.all([
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        getApiConfigs(),
        getLocalModelSettings().catch(() => null),
        getActiveLocalModel().catch(() => null),
      ]);
      if (controller.signal.aborted) return false;
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      const canHear = resolveAudioSupport(apiConfig, localMedia);
      // 回写界面状态（缺陷 2）：横幅与「片段时长/采样率」的显隐读的是 audioSupported，
      // 而它此前只在 [songId] 的探测 effect 里 set 一次——用户在面板打开后改了「支持语音识别」
      // 开关、又不切歌，界面就会一直停留在旧判断上，与实际发送行为脱节。
      // 这里每次生成都现读配置并按结果刷新，界面与行为重新对齐。
      // setAudioSupported 引用稳定（useState 的 setter），无需加入依赖数组。
      if (mountedRef.current) setAudioSupported(canHear);
      // 具备听音频能力时准备音频片段（默认从当前播放位置起 30 秒）；否则纯文字评论。
      const startMs = kind === 'opening' ? 0 : Math.max(0, Math.floor(Number(atMs)) || 0);
      const settings = clipSettingsRef.current || {};
      const songAudio = canHear
        ? await prepareSongAudioForModel(currentSong, clipAudioRef.current, {
          startMs,
          // 默认值必须**可达**：clipSeconds/sampleRate 无效（未配置）时归 0 再走 || 兜底，
          // 不能像原来那样先 Math.max(1, ...) 把无效值变成 1ms / 1Hz。
          durationMs: Math.floor(positiveOrZero(settings.clipSeconds) * 1000) || CLIP_DURATION_MS,
          sampleRate: Math.floor(positiveOrZero(settings.sampleRate)) || CLIP_SAMPLE_RATE,
        })
        : null;
      if (controller.signal.aborted) return false;
      const withAudio = !!songAudio;
      const prompt = kind === 'opening'
        ? buildOpeningCommentPrompt({ songName: currentSong.name, durationMs: currentSong.durationMs, withAudio })
        : buildTriggerCommentPrompt({
          songName: currentSong.name,
          positionMs: atMs,
          durationMs: currentSong.durationMs,
          note,
          withAudio,
        });
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: [],
        userText: prompt,
        userProfile: profile || {},
        globalPresets: presets,
        summaryText: '',
        memorySnippets: '',
        pluginContext: '',
        images: [],
        quote: null,
        voiceAudio: songAudio,
      });
      const activeConfig = apiConfig.configs.find(item => item.id === apiConfig.activeId)
        || apiConfig.configs[0];
      const expectedConfigId = String((activeConfig && activeConfig.id) || '');
      const expectedConfigFingerprint = activeConfig ? getConfigFingerprint(activeConfig) : '';
      // 本地路径：按本地模型能力裁剪媒体（音频）；在线路径：按在线配置能力裁剪。
      const localFileInfo = (localItem || localSettings)
        ? await getLocalModelFileInfo(localItem || localSettings).catch(() => null)
        : null;
      const localReady = canUseLocalModel(localSettings, localFileInfo, localItem);
      const localMessages = localReady
        ? filterRequestMedia(requestMessages, {
          allowVision: false,
          allowAudio: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasAudio),
        })
        : requestMessages;
      const onlineMessages = filterRequestMedia(requestMessages, {
        allowVision: false,
        // ⚠️ 用**仅在线**的能力判据（resolveOnlineAudioSupport），不能用上面合并了本地能力的
        // canHear：在线链路只看在线模型能力。若用 canHear，「本地模型能听」会让音频被保留并
        // 发给一个不支持音频的在线模型（本地推理失败会静默回退在线）。
        // 同时这里也**不能**再读配置级 activeConfig.supportsAudio：那是废弃的旧口径、
        // 新配置上恒为 false——那样横幅说「能听」而音频在这一步被剥掉，用户看到模型对着空气评论。
        allowAudio: resolveOnlineAudioSupport(apiConfig),
      });
      const onlineSend = () => sendChatMessage(onlineMessages, {
        stream: false,
        signal: controller.signal,
        expectedConfigId,
        expectedConfigFingerprint,
      });
      const raw = await sendWithModelProvider({
        messages: localMessages,
        localSettings,
        localItem,
        localFileInfo,
        signal: controller.signal,
        conversationKey: `music:${String(currentSong.id || '')}`,
        onlineSend,
      });
      if (controller.signal.aborted) return false;
      // 接口空响应返回占位文本：那不是角色评论，按失败处理。
      const text = String(raw || '').trim();
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error(t('error.comments.noReply'));
      const comment = {
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        characterId: character.id,
        // 名字留空：显示层按当前语言补「角色」，切语言后旧评论也跟着变。
        characterName: String(character.name || '').trim(),
        text: text.slice(0, COMMENT_TEXT_MAX),
        atMs: kind === 'opening' ? 0 : Math.max(0, Math.floor(Number(atMs)) || 0),
        createdAt: Date.now(),
        source: kind === 'opening' ? 'opening' : 'trigger',
      };
      const next = await appendMusicComment(currentSong.id, comment);
      if (mountedRef.current && songRef.current && songRef.current.id === currentSong.id) {
        setComments(next);
        // appendMusicComment 是「读→写→回读」：它成功就说明读路径已经恢复，
        // 顺手清掉读失败标记，免得旧错误条赖着不走。
        setCommentsReadFailed(false);
      }
      lastFailedRef.current = null;
      return true;
    } catch (caught) {
      if (controller.signal.aborted || isCanceledError(caught)) return false;
      if (mountedRef.current) setError(t('music.comments.failed'));
      lastFailedRef.current = { kind, atMs, note };
      return false;
    } finally {
      generatingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setGenerating(false);
    }
  }, []);

  const retry = useCallback(() => {
    const failed = lastFailedRef.current;
    if (failed) return generate(failed);
    // 没有待重试的生成请求 → 这次错误条来自「读评论失败」，重试 = 重新读盘。
    if (commentsReadFailed) return loadComments();
    return Promise.resolve(false);
  }, [generate, loadComments, commentsReadFailed]);

  // 读失败要**并进 error** 才能被用户看见：消费面板（MusicScreen）的错误条只读 error，
  // 不合并的话读失败在界面上永远不显示；commentsError 另外单独透出，让调用方/测试能
  // 区分「读不到」与「生成失败」，也让重试走对的分支。
  const commentsError = commentsReadFailed ? t('music.comments.readFailed') : '';
  return useMemo(() => ({
    comments,
    generating,
    error: error || commentsError,
    commentsError,
    characterId,
    setCharacterId,
    generate,
    retry,
    audioSupported,
  }), [comments, generating, error, commentsError, characterId, generate, retry, audioSupported]);
}
