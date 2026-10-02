import test from 'node:test';
import assert from 'node:assert/strict';

import { createThinkSplitter, splitThinkContent } from '../src/localModel/thinkStream.js';

test('splitThinkContent：思考 + 正文完整拆分', () => {
  const split = splitThinkContent('<think>先分析问题</think>这是正式回答');
  assert.equal(split.reasoning, '先分析问题');
  assert.equal(split.text, '这是正式回答');
});

test('splitThinkContent：闭合标签后的单个换行被剥掉', () => {
  const split = splitThinkContent('<think>想一下</think>\n\n答案在这里');
  assert.equal(split.reasoning, '想一下');
  assert.equal(split.text, '\n答案在这里');
  // CRLF 也兼容
  const crlf = splitThinkContent('<think>想一下</think>\r\n答案');
  assert.equal(crlf.text, '答案');
});

test('splitThinkContent：无 think 标签的输出原样为正文', () => {
  const split = splitThinkContent('普通模型的直接回答');
  assert.equal(split.reasoning, '');
  assert.equal(split.text, '普通模型的直接回答');
  // 正文中途出现的 <think> 不是思考（只识别输出开头）
  const mid = splitThinkContent('回答里提到 <think> 这个词不算思考');
  assert.equal(mid.reasoning, '');
  assert.equal(mid.text, '回答里提到 <think> 这个词不算思考');
});

test('splitThinkContent：未闭合的 think 视为仍在思考（正文为空）', () => {
  const split = splitThinkContent('<think>思考被 maxTokens 截断');
  assert.equal(split.reasoning, '思考被 maxTokens 截断');
  assert.equal(split.text, '');
});

test('splitThinkContent：开头空白后跟 think 仍识别', () => {
  const split = splitThinkContent('\n<think>推理</think>正文');
  assert.equal(split.reasoning, '推理');
  assert.equal(split.text, '正文');
});

test('splitThinkContent：非字符串入参与自定义标签兜底', () => {
  assert.deepEqual(splitThinkContent(null), { reasoning: '', text: '' });
  assert.deepEqual(splitThinkContent(undefined), { reasoning: '', text: '' });
  // 自定义标签（如某些模型用 <reasoning>）
  const custom = splitThinkContent('<reasoning>r</reasoning>t', {
    openTag: '<reasoning>',
    closeTag: '</reasoning>',
  });
  assert.equal(custom.reasoning, 'r');
  assert.equal(custom.text, 't');
});

test('createThinkSplitter：标签跨 token 分片也能正确拆分', () => {
  const splitter = createThinkSplitter();
  // 模拟 token 流：<th | ink>思 | 考</th | ink>正 | 文 —— 标签被拆到多个 token
  ['<th', 'ink>思', '考中</th', 'ink>正', '文内容'].forEach(token => splitter.push(token));
  assert.equal(splitter.reasoning(), '思考中');
  assert.equal(splitter.text(), '正文内容');
  assert.equal(splitter.raw(), '<think>思考中</think>正文内容');
});

test('createThinkSplitter：思考未结束时正文为空、思考持续增长', () => {
  const splitter = createThinkSplitter();
  splitter.push('<think>第一');
  assert.equal(splitter.reasoning(), '第一');
  assert.equal(splitter.text(), '');
  splitter.push('步');
  assert.equal(splitter.reasoning(), '第一步');
  assert.equal(splitter.text(), '');
  splitter.push('</think>答案');
  assert.equal(splitter.reasoning(), '第一步');
  assert.equal(splitter.text(), '答案');
});

test('createThinkSplitter：无标签输出全部为正文', () => {
  const splitter = createThinkSplitter();
  splitter.push('你').push('好');
  assert.equal(splitter.text(), '你好');
  assert.equal(splitter.reasoning(), '');
});

test('splitThinkContent：无开标签但存在闭合标签（Qwen3 形态）——思考/正文正确分离', () => {
  // 回归：Qwen3 系把 <think> 放进聊天模板生成前缀，模型只生成
  // 「思考 + </think> + 正文」，此前整段被当正文渲染。
  const split = splitThinkContent('用户问我是什么模型，需要先回顾对话历史。\n思考第二段。</think>\n\n1. 我是 Sapiens AI 开发的模型。');
  assert.equal(split.reasoning, '用户问我是什么模型，需要先回顾对话历史。\n思考第二段。');
  assert.equal(split.text, '\n1. 我是 Sapiens AI 开发的模型。');
});

test('splitThinkContent：闭合标签在开头（思考为空）与紧贴正文', () => {
  assert.deepEqual(splitThinkContent('</think>答案'), { reasoning: '', text: '答案' });
  // 剥掉闭合后的单个换行
  const nl = splitThinkContent('</think>\n答案');
  assert.equal(nl.reasoning, '');
  assert.equal(nl.text, '答案');
});

test('splitThinkContent：无任何标签仍原样为正文（不受形态 2 影响）', () => {
  const split = splitThinkContent('直接回答，没有思考。');
  assert.equal(split.reasoning, '');
  assert.equal(split.text, '直接回答，没有思考。');
});

test('createThinkSplitter：流式形态 2（无开标签、闭合跨 token 分片）也能正确分流', () => {
  const splitter = createThinkSplitter();
  // 闭合标签拆到两个 token：'思考中</' + 'think>正文'
  splitter.push('思考中</').push('think>正文');
  assert.equal(splitter.reasoning(), '思考中');
  assert.equal(splitter.text(), '正文');
});

test('createThinkSplitter：形态 2 闭合标签到达前的过渡态与最终纠正', () => {
  // 形态 2（无开标签）在 </think> 到达前无从区分思考与正文：按正文显示，
  // 闭合标签一出现即自动纠正（思考归折叠加、正文重置为闭合后内容）。
  // 最终结果始终正确；过渡态是信息论上的下限，锚定为契约。
  const splitter = createThinkSplitter();
  splitter.push('先想一想');
  assert.equal(splitter.reasoning(), '');
  assert.equal(splitter.text(), '先想一想');
  splitter.push('完毕</think>');
  assert.equal(splitter.reasoning(), '先想一想完毕');
  assert.equal(splitter.text(), '');
  splitter.push('\n正式回答');
  assert.equal(splitter.reasoning(), '先想一想完毕');
  assert.equal(splitter.text(), '正式回答');
});
