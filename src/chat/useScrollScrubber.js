// 快速定位滑动条的状态与回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 共享的滚动基础设施（scrollRef / scrollToMessage）仍由 ChatScreen 持有并通过参数注入
// ——它们同时服务搜索定位与引用跳转，不归本 hook 所有。
// 2026-10-12：消息列表虚拟化后不再有逐条 messageOffsetsRef（窗口外的项没有 onLayout），
// 定位一律走 scrollToMessage（内部按当前窗口现算 index → FlatList.scrollToIndex）。

import { useCallback, useMemo, useState } from 'react';

import { getMessagePromptText } from './chatMedia.js';
import { ASSISTANT_ID, USER_ID } from './chatConstants.js';
import { formatScrubberTime, messageTimestamp } from './chatHelpers.js';
import { createMessageDerivation } from './messageDerivationStore.js';

// 定位条预览的**逐条**缓存：2026-10-18 迁移到统一派生引擎（结构 1 批次 2）。
//
// 为什么必须缓存：流式生成期间 messages 每个节流 tick 都会更新（新数组 + 新的尾部对象），
// 于是本 hook 的两个 useMemo 每个 tick 都重跑。previews 里的每个字段其实**只取决于那一条
// 消息**（时间戳、说话人、正文前 60 字），与历史里其它消息无关——按引用缓存后，每个 tick
// 只需要算「刚变化的那一条」，其余直接取缓存。
//
// 不这么做的实测代价（Node 基准，2000 条 × 平均 300 字的中文历史）：
//   scrubberPreviews 4.47 ms/tick（5000 条 × 300 字时 11.97 ms/tick，单这一项就吃掉
//   16.67ms 帧预算的 72%）。而它**无条件执行**——定位条没打开时也一样算，用户根本看不到。
// 缓存后同样的历史降到 0.02 ms/tick 量级（只剩 filter + 取缓存的数组分配）。
//
// 失效条件只有两个：说话人兜底名（characterName）与当前语言（t）。
// t 在 I18nContext.js:76-90 里由 useMemo 产出、只在 localeId 变化时换引用，所以按引用
// 比对 t 就是「语言变了要重算」的准确判据（换语言后 speaker 必须跟着变；label 走的
// formatScrubberTime 默认用模块级 tActive，而 tActive 由同一个 localeId 同步，见
// I18nContext.js:80 的 setActiveLocale）。
const derivePreview = createMessageDerivation({
  // 两个键都是「引用相等才算没变」：引擎默认 equals 逐项 ===，数组即逐位比引用。
  key: (message, characterName, t) => [characterName, t],
  compute: (message, characterName, t) => {
    const timestamp = messageTimestamp(message);
    return {
      // 保持原调用形态：不注入 t（沿用 formatScrubberTime 的默认 tActive），本次只做缓存。
      label: formatScrubberTime(timestamp),
      speaker: message.role === USER_ID
        ? t('chat.bubble.me')
        : (characterName || t('common.characterFallback')),
      text: getMessagePromptText(message).replace(/\s+/g, ' ').trim().slice(0, 60),
    };
  },
});

// 导出仅供测试直接断言缓存命中/失效行为（无渲染器也能测的那部分）；运行时唯一调用点是
// 下面的 scrubberPreviews。
export function buildScrubberPreview(message, characterName, t) {
  return derivePreview(message, characterName, t);
}

export default function useScrollScrubber({
  messages,
  characterName,
  // 定位预览里的说话人兜底文案（「我」/「角色」）走 i18n：由宿主传入 t。
  t,
  scrollRef,
  scrollToMessage,
}) {
  const [scrubberOpen, setScrubberOpen] = useState(false);

  const scrubberMessages = useMemo(
    () => messages.filter(message => (
      message
      && !message.pending
      && (message.role === USER_ID || message.role === ASSISTANT_ID)
    )),
    [messages]
  );

  const scrubberPreviews = useMemo(
    // 逐条取缓存（见文件头 buildScrubberPreview）：previews 数组每个 tick 仍是新数组，但
    // 里面未变化消息的对象是**同一份引用**——省掉「重算全历史文本 + 新建 N 个对象」。
    () => scrubberMessages.map(message => buildScrubberPreview(message, characterName, t)),
    [scrubberMessages, characterName, t]
  );

  const onScrubberSeek = useCallback(index => {
    const target = scrubberMessages[index];
    if (!target) return;
    // 虚拟化后没有逐条偏移缓存可读：一律走 scrollToMessage（按当前窗口现算 index）。
    // 目标被窗口化切走时由它扩窗重试，与搜索命中/引用跳转同一条链路。
    scrollToMessage(target.id);
  }, [scrubberMessages, scrollToMessage]);

  const onScrubberToStart = useCallback(() => {
    // FlatList 的 ref 上没有 scrollTo（VirtualizedList 只暴露 scrollToOffset /
    // scrollToIndex / scrollToEnd）——沿用旧的 scrollTo({ y: 0 }) 会静默变成空操作，
    // 「跳到开头」按钮就此失效。
    scrollRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  const onScrubberToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  return {
    scrubberOpen,
    setScrubberOpen,
    scrubberMessages,
    scrubberPreviews,
    onScrubberSeek,
    onScrubberToStart,
    onScrubberToEnd,
  };
}
