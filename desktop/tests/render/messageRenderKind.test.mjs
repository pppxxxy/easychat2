// 消息渲染分支判定（与 Android MessageBubble 的口径对齐）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { RENDER_KIND, resolveMessageRenderKind } from '../../src/render/messageRenderKind.js';

test('用户消息一律纯文本（即使含 Markdown/HTML）', () => {
  assert.equal(resolveMessageRenderKind({ role: 'user', text: '**粗** <b>x</b>' }), RENDER_KIND.PLAIN);
});

test('助手消息：含 HTML 标签走 iframe，其余走 Markdown', () => {
  assert.equal(resolveMessageRenderKind({ role: 'assistant', text: '<div>卡片</div>' }), RENDER_KIND.HTML);
  assert.equal(resolveMessageRenderKind({ role: 'assistant', text: '**粗体**' }), RENDER_KIND.MARKDOWN);
});

test('媒体、错误、空白与 pending 各自分流', () => {
  assert.equal(
    resolveMessageRenderKind({ role: 'user', kind: 'image', image: { uri: 'file:///x.png' }, text: '' }),
    RENDER_KIND.MEDIA
  );
  assert.equal(resolveMessageRenderKind({ role: 'system-error', text: '请求失败' }), RENDER_KIND.ERROR);
  assert.equal(resolveMessageRenderKind({ role: 'assistant', text: '   ' }), RENDER_KIND.EMPTY);
  assert.equal(resolveMessageRenderKind({ role: 'assistant', text: '', pending: true }), RENDER_KIND.PENDING);
  assert.equal(resolveMessageRenderKind(null), RENDER_KIND.EMPTY);
});

test('助手流式正文（pending 且有内容）仍按 Markdown 渲染', () => {
  assert.equal(resolveMessageRenderKind({ role: 'assistant', text: '部分', pending: true }), RENDER_KIND.MARKDOWN);
});
