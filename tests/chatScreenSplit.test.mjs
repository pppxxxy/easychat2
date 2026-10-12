import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ChatScreen.js'), 'utf8');
const GUARD_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useSessionGuard.js'), 'utf8');

test('会话守卫已外提为 useSessionGuard，ChatScreen 不再内联声明', () => {
  // ChatScreen 经 hook 解构获取全部守卫能力
  assert.ok(CHAT_SCREEN_SOURCE.includes("} = useSessionGuard({ activeSessionIdRef, activeCharacterIdRef });"));
  assert.ok(CHAT_SCREEN_SOURCE.includes("import useSessionGuard from './chat/useSessionGuard.js';"));
  // 原内联实现不再残留
  assert.equal(CHAT_SCREEN_SOURCE.includes('const beginSendOperation = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const invalidateSessionOperations = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const captureSessionGuard = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const [isSending, setIsSending] = useState'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const inlineImageControllerRef = useRef'), false);
  assert.equal(CHAT_SCREEN_SOURCE.match(/const \[isSwitching, setIsSwitching\] = useState/g)?.length, 1, 'isSwitching 声明应恰好一处');
});

test('useSessionGuard 保有守卫语义的关键行为（L 系：按会话准入）', () => {
  // beginSend：按**会话**准入（同一会话不重复登记）、记录 source 基准、挂载 abort。
  // L 系改动点：准入源从「单屏幕锁」变为会话级登记表，别的会话后台跑不影响本会话发送。
  assert.ok(GUARD_SOURCE.includes('if (sessionRuns.has(sessionId)) return null;'));
  assert.ok(GUARD_SOURCE.includes('sourceChangedRef.current = false;'));
  assert.ok(GUARD_SOURCE.includes('abortRef.current = controller;'));
  // endSend：释放登记表中对应的运行，并重新对齐活动会话的界面锁
  assert.ok(GUARD_SOURCE.includes('if (!token) return;'));
  assert.ok(GUARD_SOURCE.includes('sessionRuns.finish(token.sessionId);'));
  assert.ok(GUARD_SOURCE.includes('syncActiveRun();'));
  // invalidate：版本号推进 + 中断开场白请求与配图请求
  assert.ok(GUARD_SOURCE.includes('sessionVersionRef.current += 1;'));
  assert.ok(GUARD_SOURCE.includes('openingRequestRef.current += 1;'));
  assert.ok(GUARD_SOURCE.includes('inlineImageControllerRef.current?.abort();'));
  // L 系关键回归钉：切会话**不再中止**后台运行（改为 detach，运行继续跑完并落回自己的会话）
  assert.equal(GUARD_SOURCE.includes('abortRef.current.abort();'), false, 'invalidate 不再中止后台运行');
  // guard 判定：三要素（会话、角色、版本）全等才视为当前
  assert.ok(GUARD_SOURCE.includes('activeSessionIdRef.current === guard.sessionId'));
  assert.ok(GUARD_SOURCE.includes('activeCharacterIdRef.current === guard.characterId'));
  assert.ok(GUARD_SOURCE.includes('sessionVersionRef.current === guard.version'));
});

test('会话切换流程已外提为 useSessionSwitch，ChatScreen 不再内联', () => {
  // 2026-10-12 起还从这里带上「切换失败统一反馈」（运行中角色条那条路径要用同一个）。
  assert.match(
    CHAT_SCREEN_SOURCE,
    /import useSessionSwitch(?:, \{ notifySwitchFailure \})? from '\.\/chat\/useSessionSwitch\.js';/,
    'ChatScreen 从 useSessionSwitch 引入 hook（及切换失败反馈）'
  );
  assert.ok(CHAT_SCREEN_SOURCE.includes('} = useSessionSwitch({'));
  // 原内联实现不再残留
  assert.equal(CHAT_SCREEN_SOURCE.includes('const onSwitch = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const onSwitchGroup = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const confirmGreeting = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const onNewChat = useCallback'), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('const [switcherOpen, setSwitcherOpen] = useState'), false, 'switcherOpen 应由 hook 持有');
  assert.equal(CHAT_SCREEN_SOURCE.match(/const \[isSwitching, setIsSwitching\] = useState/g)?.length, 1, 'isSwitching 仍归 ChatScreen 持有且恰一处');
});

test('运行中角色条切会话失败必须给反馈（不再空 catch 吞掉）', () => {
  // 2026-10-12 修：onOpenRunning 的 catch 原来是 `catch (error) {}` —— 用户点运行中
  // 角色条想切过去，失败时界面毫无反应（成因与两个切换入口相同：角色已删/归属守卫拒绝）。
  const block = /const onOpenRunning = useCallback\(async sessionId => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(CHAT_SCREEN_SOURCE);
  assert.ok(block, '未找到 onOpenRunning');
  assert.ok(block[0].includes('notifySwitchFailure(t, error)'), '失败要走统一反馈');
  assert.equal(/catch \(error\) \{\}/.test(block[0]), false, '不得再是空 catch');
});

test('useSessionSwitch 保有切换流程的关键守卫语义', () => {
  const SWITCH_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useSessionSwitch.js'), 'utf8');
  // onSwitch/onSwitchGroup：token 守卫 + 草稿快照 + 失败回滚
  assert.equal(SWITCH_SOURCE.split('const switchToken = ++switchOperationRef.current;').length - 1, 2, '两个切换入口各自持有 token');
  // 失败反馈收口到 notifySwitchFailure（2026-10-12）：原来只弹一句笼统的「请检查存储空间或
  // 权限」，既不说原因、成因也说错了（真实成因是角色已删 / 会话归属守卫拒绝）。现在两个入口
  // 都把 error 交给同一个 helper。
  assert.equal(SWITCH_SOURCE.split('notifySwitchFailure(t, error);').length - 1, 2, '两个切换入口各自报切换失败');
  assert.ok(SWITCH_SOURCE.includes('export function notifySwitchFailure(t, error)'), '反馈函数从本模块导出（ChatScreen 运行中角色条复用）');
  assert.ok(SWITCH_SOURCE.includes('maskSecrets('), '显示的 error.message 必须过 maskSecrets');
  assert.equal(zhCN['chat.session.switchFailed.title'], '切换失败', '语言包中文值正确');
  assert.equal(zhCN['chat.session.switchFailed.body'], '没能切换过去，请重试。', '语言包中文值正确');
  assert.ok(SWITCH_SOURCE.includes('await switchCharacter(previousCharacterId);'));
  assert.ok(SWITCH_SOURCE.includes('setInput(draft.input);'));
  // confirmGreeting：new 模式的三重守卫与开场白注入
  assert.ok(SWITCH_SOURCE.includes('const openingText = openingTemplate.replace'));
  assert.ok(SWITCH_SOURCE.includes('setSessionGreetingSelected(sessionId, true)'));
  assert.ok(SWITCH_SOURCE.includes("openGreetingPicker('new');"));
  // 群聊新建走 createGroupSession 且旧对话保留
  assert.ok(SWITCH_SOURCE.includes('createGroupSession(groupCharactersRef.current'));
});

test('hook 调用点参数不存在 TDZ：声明语句必须先于调用点结束', () => {
  // 背景：useSessionSwitch 曾在 useChatSearch 解构之前读取其 setter（TDZ，
  // 挂载即崩）。lint no-undef 与 Node 测试都查不出声明顺序问题，这里做静态检查：
  // 对每个 hook 调用点的每个入参名，必须存在一条声明语句（const/let/var 或
  // 解构续行），且该语句的结束行（首个以 ; 结尾的行）严格早于调用点起始行。
  const lines = CHAT_SCREEN_SOURCE.split('\n');

  const findCallStart = name => lines.findIndex(l => l.includes(`} = ${name}({`));
  const statementEnd = startIdx => {
    for (let i = startIdx; i < lines.length; i++) {
      if (lines[i].trimEnd().endsWith(';')) return i;
    }
    return -1;
  };

  for (const hookName of ['useSessionGuard', 'useSessionMessages', 'useSessionSwitch', 'useChatSend']) {
    const callLine = findCallStart(hookName);
    assert.ok(callLine >= 0, `应能定位 ${hookName} 调用`);
    // 调用点参数名：从 "} = useXxx({" 起到 "});" 止（参数可能与其同行或换行）
    const paramNames = [];
    let after = lines[callLine].split('({')[1] || '';
    let i = callLine;
    while (i < lines.length) {
      const line = i === callLine ? after : lines[i];
      if (line.trim() === '});' || line.includes('});')) {
        const seg = line.split('})')[0];
        for (const piece of seg.split(',')) {
          const m = piece.trim().match(/^([A-Za-z_$][\w$]*)$/);
          if (m) paramNames.push(m[1]);
        }
        break;
      }
      const m = line.trim().match(/^([A-Za-z_$][\w$]*),?$/);
      if (m) paramNames.push(m[1]);
      i++;
    }
    assert.ok(paramNames.length > 0, `${hookName} 应有入参`);

    for (const name of paramNames) {
      const esc = name.replace(/\$/g, '\\$');
      const declRe = new RegExp(`^(?:const|let|var)\\s+${esc}\\b\\s*=|^(?:const|let|var)\\s*[\\[{][^;]*\\b${esc}\\b|^${esc}\\b\\s*[,:]\\s*$|^${esc}\\s*,\\s*$`);
      let declaredBefore = false;
      for (let i = 0; i < callLine; i++) {
        if (declRe.test(lines[i].trim())) {
          if (statementEnd(i) !== -1 && statementEnd(i) < callLine) {
            declaredBefore = true;
            break;
          }
        }
      }
      assert.ok(
        declaredBefore,
        `${hookName} 的入参 ${name} 在调用点(第 ${callLine + 1} 行)之前未完成声明 → TDZ 崩溃`
      );
    }
  }
});

test('MessageList 窗口化虚拟化：尾部窗口、扩窗入口与真实动画距离', () => {
  const messageListSource = readFileSync(path.join(HERE, '..', 'src', 'chat', 'MessageList.js'), 'utf8');
  // 只渲染尾部 windowSize 条
  assert.ok(messageListSource.includes('renderedMessages.slice(totalCount - windowSize)'));
  // 有隐藏消息时提供「加载更早消息」入口；必须包一层箭头函数，不能直接传
  // onExpandWindow——RN onPress 会传事件对象，会被当作 step 让窗口尺寸变 NaN。
  assert.ok(messageListSource.includes('hiddenCount > 0 ? ('));
  assert.ok(messageListSource.includes('onPress={() => onExpandWindow()}'));
  assert.ok(!messageListSource.includes('onPress={onExpandWindow}'));
  // 入场动画距离按全量列表计算（窗口内 index 加上被切走的偏移）
  assert.ok(messageListSource.includes('totalCount - 1 - (hiddenCount + index)'));
  // ChatScreen：定位窗口外消息时扩窗重试；切会话重置窗口
  assert.ok(CHAT_SCREEN_SOURCE.includes('expandMessageWindow(MESSAGE_WINDOW_STEP_SCROLL)'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('setMessageWindowSize(MESSAGE_WINDOW_INITIAL);'));
});

test('hook 签名与调用点参数集双向匹配', () => {
  // 背景：useChatSend 曾签名要求 4 个参数而调用点漏传（运行时崩溃、lint 与
  // TDZ 检查都查不出）。本测试对每个 hook 做「签名参数集 == 调用点参数集」
  // 的双向比对，缺失与多余都报错。
  const lines = CHAT_SCREEN_SOURCE.split('\n');
  const hooks = [
    ['useSessionGuard', 'src/chat/useSessionGuard.js'],
    ['useSessionMessages', 'src/chat/useSessionMessages.js'],
    ['useSessionSwitch', 'src/chat/useSessionSwitch.js'],
    ['useChatSend', 'src/chat/useChatSend.js'],
  ];
  const callStart = name => lines.findIndex(l => l.includes(`} = ${name}({`));
  const callParams = name => {
    const start = callStart(name);
    const after = lines[start].split('({')[1] || '';
    const names = [];
    let i = start;
    while (i < lines.length) {
      const line = i === start ? after : lines[i];
      if (line.includes('}) {') || line.includes('});')) {
        const seg = line.split('})')[0];
        seg.split(',').forEach(p => {
          const m = p.trim().match(/^([A-Za-z_$][\w$]*)$/);
          if (m) names.push(m[1]);
        });
        break;
      }
      const m = line.trim().match(/^([A-Za-z_$][\w$]*),?$/);
      if (m) names.push(m[1]);
      i++;
    }
    return names;
  };
  const signatureParams = file => {
    const src = readFileSync(path.join(HERE, '..', file), 'utf8').split('\n');
    const start = src.findIndex(l => l.includes('({') && (l.includes('export default function') || l.trim().startsWith('export default function')));
    // 签名可能起始于上一行（export default function useXxx({）
    const names = [];
    let i = start;
    while (i < src.length) {
      const line = src[i];
      // 单行签名：({ a, b }) { 同行同时含开与闭
      if (i === start && line.includes('({') && line.includes('})')) {
        const seg = line.split('({')[1].split('})')[0];
        seg.split(',').forEach(p => {
          const m = p.trim().match(/^([A-Za-z_$][\w$]*)$/);
          if (m) names.push(m[1]);
        });
        break;
      }
      if (line.includes('}) {') || line.trim() === '}) {') break;
      if (i > start || line.includes('({')) {
        const seg = line.includes('({') ? line.split('({')[1] : line;
        seg.split(',').forEach(p => {
          const m = p.trim().match(/^([A-Za-z_$][\w$]*)$/);
          if (m) names.push(m[1]);
        });
      }
      i++;
    }
    return names;
  };
  for (const [name, file] of hooks) {
    const sig = new Set(signatureParams(file));
    const call = new Set(callParams(name));
    for (const p of sig) {
      assert.ok(call.has(p), `${name} 签名要求 ${p} 但调用点未传 → 运行时 undefined`);
    }
    for (const p of call) {
      assert.ok(sig.has(p), `${name} 调用点传了 ${p} 但签名没有 → 死参数`);
    }
  }
});
