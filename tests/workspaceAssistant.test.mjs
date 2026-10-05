// 工作区默认助手：挑卡与解析矩阵（纯函数，Node 直测）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickWorkspaceAssistant,
  resolveWorkspaceCharacter,
  WORKSPACE_ASSISTANT_NAME,
  WORKSPACE_ASSISTANT_PROMPT,
} from '../src/workspace/assistant.js';

test('pickWorkspaceAssistant：名字+提示词双匹配优先，名字匹配兜底，找不到返回 null', () => {
  const exact = { id: 'a', name: WORKSPACE_ASSISTANT_NAME, systemPrompt: WORKSPACE_ASSISTANT_PROMPT };
  const renamedPrompt = { id: 'b', name: WORKSPACE_ASSISTANT_NAME, systemPrompt: '改过的提示词' };
  const other = { id: 'c', name: '别的角色', systemPrompt: WORKSPACE_ASSISTANT_PROMPT };

  assert.equal(pickWorkspaceAssistant([other, renamedPrompt, exact]), exact, '双匹配优先于名字匹配');
  assert.equal(pickWorkspaceAssistant([other, renamedPrompt]), renamedPrompt, '提示词被改过仍按名字命中');
  assert.equal(pickWorkspaceAssistant([other]), null, '同提示词但不同名字不算工作助手');
  assert.equal(pickWorkspaceAssistant([]), null);
  assert.equal(pickWorkspaceAssistant(null), null);
});

test('resolveWorkspaceCharacter：设置 id 命中即用；否则落默认助手；都没有则标记待建卡', () => {
  const exact = { id: 'a', name: WORKSPACE_ASSISTANT_NAME, systemPrompt: WORKSPACE_ASSISTANT_PROMPT };
  const chosen = { id: 'mine', name: '我的角色', systemPrompt: '' };

  const hit = resolveWorkspaceCharacter('mine', [chosen, exact]);
  assert.equal(hit.character, chosen, '设置里的 id 命中直接用');
  assert.equal(hit.needsEnsure, false);

  const fallback = resolveWorkspaceCharacter('', [chosen, exact]);
  assert.equal(fallback.character, exact, '未设置时落到默认助手');
  assert.equal(fallback.needsEnsure, false);

  const missing = resolveWorkspaceCharacter('gone', [chosen, exact]);
  assert.equal(missing.character, exact, '设置里的 id 失效时也落到默认助手');

  const empty = resolveWorkspaceCharacter('', [chosen]);
  assert.equal(empty.character, null, '库里没有默认助手');
  assert.equal(empty.needsEnsure, true, '需要建卡');

  const emptyMissing = resolveWorkspaceCharacter('gone', []);
  assert.equal(emptyMissing.needsEnsure, true);
});