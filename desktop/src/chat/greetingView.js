// 开场白视图（桌面）：候选列表、当前选中、写入补丁、消息插入——纯逻辑，Node 直测。
//
// 为什么必须有这一层：手机版新建对话先走「开场白选择」，选完把 firstMes 写回角色卡、
// 并用它作为新会话的第一条消息；`startNewSession(characterId, {text, template})` 借此把
// 会话标成 `greetingSelected: true`。桌面此前「+」直接 `startNewSession(characterId)`
// 不带开场白，于是会话 `greetingSelected: false`，而共享发送链路有一条硬闸：
//
//     if (!isGroupRef.current && !greetingReady) return false;   // useChatSend
//
// 结果就是**新建的对话发不出消息**，而且没有任何提示（返回值 false 被宿主忽略）。
// 本模块承接手机 confirmGreeting 的判定，全部做成纯函数，便于钉住边界。
import {
  buildGreetingImport,
  isGreetingMessage,
  listGreetingCandidates,
} from '../../../src/character/cardGreetings.js';
import { buildGreetingMessage } from '../../../src/chat/chatHelpers.js';

// 角色卡里的开场白候选（firstMes + alternateGreetings，空白项已剔除）。
export function greetingCandidatesOf(character) {
  return listGreetingCandidates(character || {});
}

// 打开选择器时的初始状态：候选、当前开场白原文、应选中的下标。
//
// 口径照抄手机 ChatScreen.openGreetingPicker：
//   · 会话里已有开场白 → 选中它；它不在候选里（用户改过）则回落到第一条候选；
//   · 会话里没有开场白 → 选第一条候选；没有候选则 -1（= 不使用开场白）。
export function greetingPickerState({ character, messages, sessionId } = {}) {
  const candidates = greetingCandidatesOf(character);
  const list = Array.isArray(messages) ? messages : [];
  const current = list.find(item => isGreetingMessage(item, sessionId));
  // greetingTemplate 是用户编辑前的原文；没有则退回消息正文（老数据只有 text）。
  const currentText = String((current && (current.greetingTemplate || current.text)) || '');
  const found = candidates.findIndex(item => item.text === currentText);
  let initialSelectedIndex;
  if (current) {
    initialSelectedIndex = found >= 0 ? found : (candidates.length > 0 ? 0 : -1);
  } else {
    initialSelectedIndex = candidates.length > 0 ? 0 : -1;
  }
  return { candidates, currentText, initialSelectedIndex };
}

// 由「草稿数组 + 选中下标」得到要写回角色卡的补丁，以及新会话的开场白正文。
//
// `firstMes` 同时是「之后新建对话的默认开场白」与「本次新会话的第一条消息」；
// `{{user}}` 在正文里替换成用户名（没有则用调用方给的兜底词条），模板里保留占位符
// ——这样之后改用户名，历史开场白不会被改写。
export function greetingSelection(drafts, selectedIndex, { userName = '', fallbackUserName = '' } = {}) {
  const patch = buildGreetingImport(drafts, selectedIndex);
  const openingTemplate = String(patch.firstMes || '');
  const openingText = openingTemplate.replace(/\{\{user\}\}/g, () => userName || fallbackUserName);
  return { patch, openingTemplate, openingText };
}

// 新建一段会话时传给 startNewSession 的 opening 参数。
// 非 null 即代表「已选过开场白」，startNewSession 据此置 greetingSelected=true
// ——这正是发送闸门放行的条件，所以即使选「不使用开场白」也必须传对象。
export function newSessionOpening(selection) {
  const opening = selection || {};
  return {
    text: String(opening.openingText || ''),
    template: String(opening.openingTemplate || ''),
  };
}

// 把选定的开场白并进当前时间线（口径照抄手机 confirmGreeting）：
//   · 给了开场白且时间线里还没有 → 插到最前面；
//   · 给出了且已有 → 原位替换正文，保留原 id 与时间戳（不制造假的新消息）；
//   · 选「不使用开场白」→ 删掉已有的开场白消息。
export function applyGreetingToMessages(messages, sessionId, greeting) {
  const list = Array.isArray(messages) ? messages : [];
  const hasGreeting = list.some(item => isGreetingMessage(item, sessionId));
  if (!greeting) return list.filter(item => !isGreetingMessage(item, sessionId));
  if (!hasGreeting) return [greeting, ...list];
  return list.map(item => (
    isGreetingMessage(item, sessionId)
      ? { ...item, ...greeting, id: item.id, timestamp: item.timestamp }
      : item
  ));
}

// 由角色卡补丁构造开场白消息（null = 不使用开场白）。userName 为空时用兜底词条，
// 否则 buildGreetingMessage 会跳过 {{user}} 替换，把占位符原样显示给用户。
export function greetingMessageFor(sessionId, patch, { userName = '', fallbackUserName = '' } = {}) {
  const firstMes = String((patch && patch.firstMes) || '');
  if (!firstMes) return null;
  return buildGreetingMessage(sessionId, firstMes, userName || fallbackUserName);
}