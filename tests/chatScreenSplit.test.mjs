import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

test('useSessionGuard 保有原守卫语义的关键行为', () => {
  // beginSend：锁定唯一 token、记录 source 基准、挂载 abort
  assert.ok(GUARD_SOURCE.includes('if (sendLockRef.current) return null;'));
  assert.ok(GUARD_SOURCE.includes('sourceChangedRef.current = false;'));
  assert.ok(GUARD_SOURCE.includes('abortRef.current = controller;'));
  // endSend：仅 token 匹配时释放
  assert.ok(GUARD_SOURCE.includes("if (!token || sendLockRef.current !== token) return;"));
  assert.ok(GUARD_SOURCE.includes('if (abortRef.current === token.controller) abortRef.current = null;'));
  // invalidate：版本号推进 + 中断开场白请求与配图请求
  assert.ok(GUARD_SOURCE.includes('sessionVersionRef.current += 1;'));
  assert.ok(GUARD_SOURCE.includes('openingRequestRef.current += 1;'));
  assert.ok(GUARD_SOURCE.includes('inlineImageControllerRef.current?.abort();'));
  // guard 判定：三要素（会话、角色、版本）全等才视为当前
  assert.ok(GUARD_SOURCE.includes('activeSessionIdRef.current === guard.sessionId'));
  assert.ok(GUARD_SOURCE.includes('activeCharacterIdRef.current === guard.characterId'));
  assert.ok(GUARD_SOURCE.includes('sessionVersionRef.current === guard.version'));
});
