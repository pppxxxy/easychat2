// ask_user（AskUserQuestion 对齐）：选项归一 / 工具执行 / 宿主询问。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_TOOL_DEFINITION,
  normalizeAskOptions,
} from '../src/workspace/toolDefs/askUserTool.js';
import { promptUserChoice } from '../src/chat/askUserPrompt.js';

test('normalizeAskOptions：trim / 去空 / 限个数', () => {
  assert.deepEqual(normalizeAskOptions([' a ', '', 'b', 'c', 'd']), ['a', 'b', 'c']);
  assert.equal(ASK_USER_MAX_OPTIONS, 3);
  assert.deepEqual(normalizeAskOptions(null), []);
});

test('ask_user 工具：缺参报错 / 无钩子拒绝 / 有钩子返回选择', async () => {
  const tool = ASK_USER_TOOL_DEFINITION;
  assert.equal(tool.name, 'ask_user');
  assert.equal(tool.readOnly, true);

  assert.equal((await tool.execute({}, { options: ['a', 'b'] }, {})).isError, true, '缺 question');
  assert.equal((await tool.execute({}, { question: 'q', options: ['a'] }, {})).isError, true, '选项不足 2');
  assert.equal((await tool.execute({}, { question: 'q', options: ['a', 'b'] }, {})).isError, true, '无 ask 钩子');

  const ok = await tool.execute({}, { question: 'q', options: ['a', 'b'] }, {
    ask: async ({ question, options }) => {
      assert.equal(question, 'q');
      assert.deepEqual(options, ['a', 'b']);
      return 'a';
    },
  });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /用户选择了：a/);

  const cancelled = await tool.execute({}, { question: 'q', options: ['a', 'b'] }, { ask: async () => null });
  assert.equal(cancelled.isError, true);
});

test('ask_user 声明了远大于默认 15s 的超时（阻塞等用户选择，不能被误判超时）', () => {
  assert.ok(ASK_USER_TOOL_DEFINITION.timeoutMs >= 60000, `期望 ≥60s，实为 ${ASK_USER_TOOL_DEFINITION.timeoutMs}`);
});

test('promptUserChoice：无 alert → null；有 alert → 选项/取消回填', async () => {
  assert.equal(await promptUserChoice({ question: 'q', options: ['a', 'b'] }), null);

  let captured = null;
  const alert = (title, message, buttons) => { captured = { title, message, buttons }; };
  const pending = promptUserChoice({ question: 'q', options: ['a', 'b'], cancelLabel: '取消', alert });
  assert.equal(captured.title, 'q');
  assert.equal(captured.buttons.length, 3, 'a + b + 取消');
  captured.buttons[0].onPress();
  assert.equal(await pending, 'a');
});
