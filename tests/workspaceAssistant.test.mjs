// 工作区默认助手：挑卡与解析矩阵（纯函数，Node 直测）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickFallbackCharacter,
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

test('resolveWorkspaceCharacter：设置 id 命中即用；否则落默认助手；都没有则回落且不建卡', () => {
  const exact = { id: 'a', name: WORKSPACE_ASSISTANT_NAME, systemPrompt: WORKSPACE_ASSISTANT_PROMPT };
  const chosen = { id: 'mine', name: '我的角色', systemPrompt: '' };
  const builtin = { id: 'default', name: 'EasyChat2 助手', systemPrompt: '', builtin: true };

  const hit = resolveWorkspaceCharacter('mine', [chosen, exact]);
  assert.equal(hit.character, chosen, '设置里的 id 命中直接用');
  assert.equal(hit.needsEnsure, false);

  const fallback = resolveWorkspaceCharacter('', [chosen, exact]);
  assert.equal(fallback.character, exact, '未设置时落到默认助手');
  assert.equal(fallback.needsEnsure, false);

  const missing = resolveWorkspaceCharacter('gone', [chosen, exact]);
  assert.equal(missing.character, exact, '设置里的 id 失效时也落到默认助手');

  // 用户删掉了工作助手：不再建卡（删掉的卡不会复活），回落内置助手
  const noAssistant = resolveWorkspaceCharacter('', [chosen, builtin]);
  assert.equal(noAssistant.character, builtin, '回落优先内置助手（builtin，不可删除）');
  assert.equal(noAssistant.needsEnsure, false, '不再要求建卡');

  // 异常库（连内置助手都没有）：退回库中第一个角色
  const noBuiltin = resolveWorkspaceCharacter('', [chosen]);
  assert.equal(noBuiltin.character, chosen, '退而用库里第一个角色');
  assert.equal(noBuiltin.needsEnsure, false, '同样不建卡');

  const empty = resolveWorkspaceCharacter('gone', []);
  assert.equal(empty.character, null, '库为空才没有角色');
  assert.equal(empty.needsEnsure, false, '库为空也不建卡，由面板兜底不阻断打开');
});

test('pickFallbackCharacter：内置助手优先，其次库中第一个，空库返回 null', () => {
  const builtin = { id: 'default', builtin: true };
  const other = { id: 'x' };
  assert.equal(pickFallbackCharacter([other, builtin]), builtin, 'builtin 优先于排序更前的角色');
  assert.equal(pickFallbackCharacter([other]), other);
  assert.equal(pickFallbackCharacter([]), null);
  assert.equal(pickFallbackCharacter(null), null);
});