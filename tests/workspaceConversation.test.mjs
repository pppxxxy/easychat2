// W1：工作区会话行投影（src/workspace/conversation.js）。
//
// 这一层是后面所有「看得见 agent 在干什么」的地基：工具卡片（W2）、压缩分隔行、
// 回合小结都要从行模型上长出来，而不是各自回 messages 里现算。所以先把契约钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_ROW_KINDS,
  buildConversationRows,
  previewToolResult,
  summarizeToolArgs,
  toolNoticeText,
  toolRowsFromTrace,
} from '../src/workspace/conversation.js';
import { COMPACTION_MARKER } from '../src/chat/compaction.js';
import { translate } from '../src/i18n/index.js';

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('summarizeToolArgs：按工具取最能认人的那个字段；认不出就空串（不甩 JSON）', () => {
  assert.equal(summarizeToolArgs('read_workspace_file', { path: 'src/app.js' }), 'src/app.js');
  assert.equal(summarizeToolArgs('search_workspace', { pattern: 'needle' }), 'needle');
  assert.equal(summarizeToolArgs('run_shell', { command: 'npm  test\n  --run' }), 'npm test --run', '空白折叠');
  assert.equal(summarizeToolArgs('update_plan', { plan: [{ status: 'done' }, { status: 'pending' }] }), '1/2 步');
  assert.equal(summarizeToolArgs('unknown_tool', { weird: 1 }), '');
  assert.equal(summarizeToolArgs('read_workspace_file', '{坏 JSON'), '', '参数不是 JSON 也不抛');
  assert.equal(summarizeToolArgs('read_workspace_file', undefined), '');
  const long = summarizeToolArgs('read_workspace_file', { path: 'x'.repeat(200) });
  assert.equal(long.endsWith('…'), true, '过长截断');
});

test('previewToolResult：取首个非空行并截断；空内容空串', () => {
  assert.equal(previewToolResult(''), '');
  assert.equal(previewToolResult('\n\n第二行有内容\n第三行'), '第二行有内容');
  assert.equal(previewToolResult('  a   b  '), 'a b');
  assert.equal(previewToolResult('x'.repeat(300)).length, 121, '120 + 省略号');
});

test('toolRowsFromTrace：调用与结果按 tool_call_id 配对，状态如实', () => {
  const rows = toolRowsFromTrace([
    { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'read_workspace_file', { path: 'a.js' }), toolCall('c2', 'write_workspace_file', { path: 'b.js' })] },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容第一行\n第二行' },
    { role: 'tool', tool_call_id: 'c2', content: '错误：写入失败' },
  ], { messageId: 'm1' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.kind, row.tool.name, row.tool.args, row.tool.status]), [
    ['tool', 'read_workspace_file', 'a.js', 'ok'],
    ['tool', 'write_workspace_file', 'b.js', 'error'],
  ]);
  assert.equal(rows[0].tool.resultPreview, '文件内容第一行');
  assert.equal(rows[0].key, 'tool:m1:c1');
  assert.equal(rows[0].tool.resultLength, '文件内容第一行\n第二行'.length);
});

test('toolRowsFromTrace：轨迹被截断（结果缺失）时记 unknown，不假装成功也不假装失败', () => {
  const rows = toolRowsFromTrace([
    { role: 'assistant', content: '', tool_calls: [toolCall('c9', 'run_shell', { command: 'ls' })] },
  ], { messageId: 'm2' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool.status, 'unknown');
  assert.equal(rows[0].tool.resultPreview, '');
});

test('toolRowsFromTrace：状态优先信权威 isError（正文正则只是老轨迹的回落）', () => {
  const rows = toolRowsFromTrace([
    { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'read_workspace_file', { path: 'a.js' }), toolCall('c2', 'read_workspace_file', { path: 'b.js' })] },
    // 正文不含「错误/失败/Error:」——正则看不出来，但权威标记说失败了 → 必须判 error。
    { role: 'tool', tool_call_id: 'c1', content: '文件不存在：notes/x.txt', isError: true },
    // 正文恰好含「错误」字样，但权威标记说成功了 → 必须判 ok（不被正文误导）。
    { role: 'tool', tool_call_id: 'c2', content: '日志里出现了“错误”二字，但这次读取成功', isError: false },
  ], { messageId: 'm3' });
  assert.deepEqual(rows.map(row => row.tool.status), ['error', 'ok']);
});

// ---- 界面侧提示（noticeKey/noticeParams）：第 3 跳 + 第 4 跳 ----
//
// 工具结果正文（content）是给模型读的中文，按铁律不得翻译；界面要按当前语言渲染就得靠
// 结果上额外带的 noticeKey/noticeParams（toolDefs/toolNotices.js）。这条链是
//   工具定义 → registry → loop 的 tool 消息 → toolTrace → 本层（row.tool）→ ToolCallRow
// 每一跳都可能只挑字段，所以逐跳钉住：这一层只**搬运**（不翻译），取词由 toolNoticeText 做。
test('toolRowsFromTrace：界面侧提示字段搬进 row.tool；老轨迹（无该字段）保持没有', () => {
  const rows = toolRowsFromTrace([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        toolCall('c1', 'git_status', {}),
        toolCall('c2', 'run_workflow', {}),
        toolCall('c3', 'read_workspace_file', { path: 'a.js' }),
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      content: '本地版本控制还没就绪：这个工作区还没有 git 仓库。',
      isError: true,
      noticeKey: 'workspace.chat.tool.notice.gitNoRepo',
    },
    {
      role: 'tool',
      tool_call_id: 'c2',
      content: '工作流无法执行：步骤 write-step 要求 write 模式……',
      isError: true,
      noticeKey: 'workspace.chat.tool.notice.workflowWriteBlocked',
      noticeParams: { steps: 'write-step' },
    },
    { role: 'tool', tool_call_id: 'c3', content: '文件内容第一行' },
  ], { messageId: 'm9' });
  assert.equal(rows[0].tool.noticeKey, 'workspace.chat.tool.notice.gitNoRepo');
  assert.equal('noticeParams' in rows[0].tool, false, '没有参数就不塞空对象/undefined 键');
  assert.deepEqual(rows[1].tool.noticeParams, { steps: 'write-step' }, '插值参数原样搬到行上');
  assert.equal('noticeKey' in rows[2].tool, false, '老轨迹保持无该字段——展示层据此回落中文正文');
  // 正文一个字都没被界面接线改动（模型侧文本不受影响），回落时显示的就是它
  assert.equal(rows[0].tool.resultText, '本地版本控制还没就绪：这个工作区还没有 git 仓库。');
});

// 取词（第 4 跳）：有 noticeKey 走词条（中英各一次），没有则返回空串交给渲染层回落中文正文。
// 这里用真实的 translate() 而不是打桩——「英文界面不再显示中文」正是这一跳要证的事。
const tFor = locale => (key, params) => translate(locale, key, params);

test('toolNoticeText：有 noticeKey 时按当前语言取词条（中英各一次），并透传 noticeParams', () => {
  const key = 'workspace.chat.tool.notice.gitNoRepo';
  const zh = toolNoticeText({ noticeKey: key }, tFor('zh-CN'));
  const en = toolNoticeText({ noticeKey: key }, tFor('en'));
  assert.ok(zh.includes('本地版本控制'), `中文界面走中文词条，实际：${zh}`);
  assert.ok(en.includes('Local version control'), `英文界面走英文词条，实际：${en}`);
  assert.notEqual(zh, en, '两种语言取到的不是同一句话');

  // 带参数的那条：占位符必须被 noticeParams 填掉（t(key, params) 的既有签名）
  const workflow = toolNoticeText(
    { noticeKey: 'workspace.chat.tool.notice.workflowWriteBlocked', noticeParams: { steps: 'write-step' } },
    tFor('en'),
  );
  assert.ok(workflow.includes('write-step'), `noticeParams 要插进词条，实际：${workflow}`);
  assert.equal(/\{steps\}/.test(workflow), false, '占位符不得留在界面上');
});

test('toolNoticeText：没有 noticeKey（老轨迹）或词条取不到时返回空串，由展示层回落中文正文', () => {
  // 老轨迹：row.tool 上根本没有这两个字段，只有中文正文
  assert.equal(toolNoticeText({ resultText: '中文正文' }, tFor('en')), '', '没有 key → 空串（调用方回落正文）');
  assert.equal(toolNoticeText({ noticeKey: '' }, tFor('en')), '');
  assert.equal(toolNoticeText(null, tFor('en')), '');
  assert.equal(toolNoticeText({ noticeKey: 'k' }, null), '', '没有 t 也不能抛');
  // 词条漏登记：translate 找不到时返回 key 本身——宁可回落中文正文，也不把 key 显示给用户
  assert.equal(toolNoticeText({ noticeKey: 'not.a.registered.key' }, tFor('en')), '');
});

test('buildConversationRows：工具行排在终稿之前（发生顺序），用户/助手行按原序', () => {
  const rows = buildConversationRows({
    messages: [
      { id: 'u1', role: 'user', content: '帮我改一下' },
      {
        id: 'a1',
        role: 'assistant',
        content: '改好了',
        toolTrace: [
          { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'edit_workspace_file', { path: 'a.js' })] },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
      },
    ],
  });
  assert.deepEqual(rows.map(row => row.kind), ['user', 'tool', 'assistant']);
  assert.deepEqual(rows.map(row => row.key), ['msg:u1', 'tool:a1:c1', 'msg:a1']);
});

test('buildConversationRows：压缩产物单独成行（带 marker 的那条不是助手的回答）', () => {
  const rows = buildConversationRows({
    messages: [
      { id: 'a0', role: 'assistant', content: `${COMPACTION_MARKER}\n当前用户请求：x（权威）` },
      { id: 'u1', role: 'user', content: '继续' },
    ],
  });
  assert.equal(rows[0].kind, CONVERSATION_ROW_KINDS.COMPACTION);
  assert.equal(rows[1].kind, CONVERSATION_ROW_KINDS.USER);
});

test('buildConversationRows：报错/中止的助手消息如实带出 isError（不吞掉失败形态）', () => {
  const rows = buildConversationRows({
    messages: [{ id: 'a1', role: 'assistant', content: '已停止生成。', isError: true }],
  });
  assert.equal(rows[0].kind, CONVERSATION_ROW_KINDS.ASSISTANT);
  assert.equal(rows[0].message.isError, true);
});

test('buildConversationRows：空输入 / 脏数据安全（永不抛错——渲染层不该被数据打挂）', () => {
  assert.deepEqual(buildConversationRows({}), []);
  assert.deepEqual(buildConversationRows({ messages: null }), []);
  assert.deepEqual(buildConversationRows({ messages: [null, undefined, { role: 'system', content: 'x' }, {}] }), []);
  const rows = buildConversationRows({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(rows.length, 1, '缺 id 也能出行（key 退化成 msg:）');
  assert.equal(rows[0].key, 'msg:');
});

test('W2：toolCardKind 按工具族分派（认不出的走通用行）', async () => {
  const { toolCardKind } = await import('../src/workspace/conversation.js');
  assert.equal(toolCardKind('edit_workspace_file'), 'edit');
  assert.equal(toolCardKind('write_workspace_file'), 'write');
  assert.equal(toolCardKind('run_shell'), 'command');
  assert.equal(toolCardKind('run_python'), 'command');
  assert.equal(toolCardKind('update_plan'), 'plan');
  assert.equal(toolCardKind('run_subagent'), 'subagent');
  assert.equal(toolCardKind('read_workspace_file'), 'generic');
  assert.equal(toolCardKind('git_status'), 'generic');
  assert.equal(toolCardKind(''), 'generic');
  assert.equal(toolCardKind(null), 'generic');
});

test('W2：行里带上富卡片要的原始参数与可展开输出（超长截断并标记）', () => {
  const big = 'x'.repeat(5000);
  const rows = buildConversationRows({
    messages: [{
      id: 'a1',
      role: 'assistant',
      content: '好了',
      toolTrace: [
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'edit_workspace_file', { path: 'a.js', find: 'old', replace: 'new' })] },
        { role: 'tool', tool_call_id: 'c1', content: big },
      ],
    }],
  });
  const row = rows.find(item => item.kind === 'tool');
  assert.deepEqual(row.tool.argsRaw, { path: 'a.js', find: 'old', replace: 'new' }, '原始参数保留给卡片用');
  assert.equal(row.tool.resultLength, 5000);
  assert.equal(row.tool.resultTruncated, true);
  assert.ok(row.tool.resultText.length < 5000 && row.tool.resultText.includes('已截断'), '超长输出截断并标注');
});

test('W2：live 行是临时行（key 固定 live、状态 running、排在最后）', () => {
  const messages = [{ id: 'u1', role: 'user', content: 'hi' }];
  const withLive = buildConversationRows({ messages, live: { name: 'run_shell', round: 2 } });
  assert.equal(withLive.length, 2);
  const live = withLive[1];
  assert.equal(live.key, 'live');
  assert.equal(live.live, true);
  assert.equal(live.tool.status, 'running');
  assert.equal(live.tool.name, 'run_shell');
  assert.equal(buildConversationRows({ messages, live: null }).length, 1, '没有在跑的调用时不出 live 行');
  assert.equal(buildConversationRows({ messages, live: {} }).length, 1, '缺 name 不出行');
});

test('长任务进度：live 行带出登记时刻 startedAt（ToolCallRow 据此 tick「已运行 m:ss」）', () => {
  const messages = [{ id: 'u1', role: 'user', content: 'hi' }];
  const startedAt = 1_700_000_000_000;
  const live = buildConversationRows({ messages, live: { name: 'run_workflow', startedAt } })[1];
  assert.equal(live.tool.startedAt, startedAt);
  // 脏数据不产生 NaN：缺字段/非数字一律 0，渲染层据此退回静态「运行中…」而不显示 NaN:NaN
  assert.equal(buildConversationRows({ messages, live: { name: 'run_shell' } })[1].tool.startedAt, 0);
  assert.equal(buildConversationRows({ messages, live: { name: 'run_shell', startedAt: 'abc' } })[1].tool.startedAt, 0);
});

test('W2：turnChanges 只认改文件的工具，同文件多次只算一条（留最后操作 + 次数）', async () => {
  const { turnChanges } = await import('../src/workspace/conversation.js');
  assert.deepEqual(turnChanges([]), { files: [], count: 0 }, '空会话没有改动');
  assert.deepEqual(turnChanges([{ role: 'assistant', content: '没调工具' }]), { files: [], count: 0 });

  const messages = [
    { id: 'a0', role: 'assistant', content: '上一轮', toolTrace: [
      { role: 'assistant', content: '', tool_calls: [toolCall('z1', 'write_workspace_file', { path: 'old.txt', content: 'x' })] },
    ] },
    { id: 'u1', role: 'user', content: '再改一下' },
    { id: 'a1', role: 'assistant', content: '好了', toolTrace: [
      { role: 'assistant', content: '', tool_calls: [
        toolCall('c1', 'write_workspace_file', { path: 'a.txt', content: 'v1' }),
        toolCall('c2', 'read_workspace_file', { path: 'ignored.txt' }),
        toolCall('c3', 'edit_workspace_file', { path: 'a.txt', find: 'v1', replace: 'v2' }),
        toolCall('c4', 'create_workspace_dir', { path: 'src' }),
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ] },
  ];
  const summary = turnChanges(messages);
  assert.deepEqual(summary.files.map(item => [item.path, item.op, item.count]), [
    ['a.txt', 'edit', 2],
    ['src', 'mkdir', 1],
  ], '只取最后一个带轨迹的助手消息；同文件合并并保留最后操作；读工具不算');
  assert.equal(summary.count, 2);
});
