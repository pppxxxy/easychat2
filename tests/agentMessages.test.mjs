// D2 工具结果头尾保留截断测试（agent/messages.js serializeToolResult）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeToolResult, TOOL_RESULT_LIMIT, TOOL_RESULT_ELIDED, elideOlderToolResults } from '../src/agent/messages.js';

// 扫描孤立代理（半个 emoji）——任何位置出现都算残缺（含标注中的 -- 不重要）。
function hasLoneSurrogate(text) {
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('D2 截断：恰好上限不截断；超长头尾都保（声明在头、报错在尾）', () => {
  const exact = 'x'.repeat(TOOL_RESULT_LIMIT);
  assert.equal(serializeToolResult(exact), exact, '恰好上限原样返回');

  const head = 'H'.repeat(100);
  const tail = 'T'.repeat(100);
  const content = `${head}${'M'.repeat(TOOL_RESULT_LIMIT * 2)}${tail}`;
  // 用未知工具名（无指引后缀）验证头尾守恒；指引分派在下一个用例单独钉
  const result = serializeToolResult(content, TOOL_RESULT_LIMIT, 'materialize_repo');
  assert.ok(result.startsWith(head), '头部完整保留');
  assert.ok(result.endsWith(tail), '尾部完整保留（报错常在尾部）');
  assert.match(result, new RegExp(`中间省略 \\d+ 字符，原始 ${content.length} 字符`));
  assert.equal(/offset|收窄/.test(result), false, '未知工具无指引');
  // 头尾保留总量守恒：limit（前 1/2 + 后 1/2）
  const kept = result.slice(0, head.length) + result.slice(-tail.length);
  assert.equal(kept.length, head.length + tail.length);
});

test('D2 指引按工具名分派：文件→offset 续读；命令→收窄；未知工具不写误导性指引', () => {
  const content = 'x'.repeat(TOOL_RESULT_LIMIT + 10);
  assert.match(
    serializeToolResult(content, TOOL_RESULT_LIMIT, 'read_workspace_file'),
    /offset\/limit 分段精读/,
    '文件类给续读指引（参数名以工具定义为准：limit，不是 maxChars）'
  );
  assert.match(
    serializeToolResult(content, TOOL_RESULT_LIMIT, 'run_python'),
    /收窄命令\/代码后重跑/,
    '执行类给收窄指引'
  );
  const unknown = serializeToolResult(content, TOOL_RESULT_LIMIT, 'mcp_github_something');
  assert.equal(/offset|收窄/.test(unknown), false, '不认识的工具只做头尾保留，不写指引');
  assert.equal(
    serializeToolResult(content, TOOL_RESULT_LIMIT),
    unknown.replace(/^x+/, match => match),
    '缺省工具名与未知工具同路径（无指引）'
  );
});

test('D2 多字节安全：切点不落在代理对中间（emoji 不残缺）', () => {
  const emoji = '😀';
  // 场景 1：高代理恰在 headSize-1（切点落进 emoji 中间）→ 回退一格
  const case1 = `${'a'.repeat(TOOL_RESULT_LIMIT / 2 - 1)}${emoji}${'b'.repeat(TOOL_RESULT_LIMIT)}`;
  const r1 = serializeToolResult(case1, TOOL_RESULT_LIMIT, 'read_workspace_file');
  assert.equal(hasLoneSurrogate(r1), false, '场景 1 无孤立代理');
  assert.equal(r1.charCodeAt(r1.indexOf('\n…') - 1), 'a'.charCodeAt(0), '回退到 emoji 之前');

  // 场景 2：emoji 恰好整体在切点之后（不回退，正常切）
  const case2 = `${'a'.repeat(TOOL_RESULT_LIMIT / 2)}${emoji}${'b'.repeat(TOOL_RESULT_LIMIT)}`;
  const r2 = serializeToolResult(case2, TOOL_RESULT_LIMIT, 'read_workspace_file');
  assert.equal(hasLoneSurrogate(r2), false, '场景 2 无孤立代理');

  // 场景 3：尾切点落进 emoji 中间（低代理在 tailStart）→ 回退包住整个 emoji
  const tailPad = TOOL_RESULT_LIMIT + 1; // 让 tailStart 落在某个 emoji 的中间
  const case3 = `${'x'.repeat(TOOL_RESULT_LIMIT)}${'y'.repeat(tailPad - 1)}${emoji}${'z'.repeat(4)}`;
  const r3 = serializeToolResult(case3, TOOL_RESULT_LIMIT, 'run_shell');
  assert.equal(hasLoneSurrogate(r3), false, '场景 3 无孤立代理');

  // 大文本混合：整体扫描
  const mixed = `${emoji.repeat(3000)}${'中'.repeat(3000)}${emoji.repeat(3000)}`;
  assert.equal(hasLoneSurrogate(serializeToolResult(mixed, TOOL_RESULT_LIMIT, 'run_python')), false);
});

// ---- P2-8：同一 turn 内较早轮次的工具结果换成占位标记 ----

// 造一段「n 轮工具循环」的历史：每轮 assistant(tool_calls) + 一条 tool 结果。
function buildToolHistory(rounds, contentSize = 400) {
  const messages = [{ role: 'user', content: '任务' }];
  for (let round = 1; round <= rounds; round += 1) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${round}`, content: `${round}`.repeat(contentSize) });
  }
  return messages;
}

test('P2-8 阈值内什么都不做：总量不超预算时原样返回同一个数组', () => {
  const history = buildToolHistory(3, 10);
  const result = elideOlderToolResults(history, { budget: 10 * 1024 });
  assert.equal(result.elided, 0);
  assert.equal(result.savedChars, 0);
  assert.equal(result.messages, history, '没动就返回原数组（不是等价副本）');
});

test('P2-8 超预算时只动「较早轮次」：最近 2 轮原样、消息条数与配对不变', () => {
  const history = buildToolHistory(4, 400); // 4 × 400 = 1600 字符
  const result = elideOlderToolResults(history, { budget: 100, keepRounds: 2 });
  assert.equal(result.elided, 2, '第 1、2 轮被省略（最近 2 轮 = 第 3、4 轮受保护）');
  assert.equal(result.savedChars, 2 * (400 - TOOL_RESULT_ELIDED.length));

  const tools = result.messages.filter(item => item.role === 'tool');
  assert.equal(tools.length, 4, '消息一条都没删');
  assert.equal(tools[0].content, TOOL_RESULT_ELIDED);
  assert.equal(tools[1].content, TOOL_RESULT_ELIDED);
  assert.match(tools[0].content, /重新调用/, '占位标记要告诉模型信息可以重新取回');
  assert.equal(tools[2].content, '3'.repeat(400), '第 3 轮原样');
  assert.equal(tools[3].content, '4'.repeat(400), '最近一轮原样');

  // 配对结构（tool_call_id ⇄ assistant.tool_calls.id）一字未动——这是「只能换内容、
  // 不能删消息」那条硬边界的可执行证据。
  const ids = result.messages
    .filter(item => item.role === 'assistant' && item.tool_calls)
    .map(item => item.tool_calls[0].id);
  assert.deepEqual(ids, ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(tools.map(item => item.tool_call_id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(result.messages[0].content, '任务', '非工具消息逐字不动');
});

test('P2-8 不改入参：原数组与原消息对象都不被就地改写', () => {
  const history = buildToolHistory(3, 400);
  const before = history.map(item => ({ ...item }));
  const result = elideOlderToolResults(history, { budget: 10, keepRounds: 1 });
  assert.equal(result.elided, 2);
  assert.deepEqual(history, before, '入参数组内容不变');
  assert.equal(history[2].content, '1'.repeat(400), '入参里的消息对象没被就地改');
  assert.notEqual(result.messages[2], history[2], '被省略的是新对象（浅拷贝共享元素不能就地改）');
});

test('P2-8 幂等：对已省略的历史再跑一次不再动（已省略的不计入总量）', () => {
  const history = buildToolHistory(4, 400);
  const first = elideOlderToolResults(history, { budget: 100, keepRounds: 2 });
  assert.equal(first.elided, 2);
  const second = elideOlderToolResults(first.messages, { budget: 100, keepRounds: 2 });
  assert.equal(second.elided, 0, '第二轮无可省略项');
  assert.equal(second.savedChars, 0);
  assert.equal(second.messages, first.messages);
});

test('P2-8 轮数不够时一条都不动；keepRounds=0 时不保护任何轮', () => {
  const two = buildToolHistory(2, 400);
  assert.equal(elideOlderToolResults(two, { budget: 10, keepRounds: 2 }).elided, 0, '只有 2 轮 → 全在保护窗口内');
  const three = buildToolHistory(3, 400);
  assert.equal(elideOlderToolResults(three, { budget: 10, keepRounds: 0 }).elided, 3, 'keepRounds=0 = 不保护');
});

test('P2-8 只换「真的更省」的：比占位标记还短的结果原样留着', () => {
  const history = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'tool', tool_call_id: 'c2', content: 'x'.repeat(400) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3' }] },
    { role: 'tool', tool_call_id: 'c3', content: 'y'.repeat(400) },
  ];
  const result = elideOlderToolResults(history, { budget: 10, keepRounds: 1 });
  assert.equal(result.elided, 1, '短结果换过去反而更长，不动');
  assert.equal(result.messages[1].content, 'ok');
  assert.equal(result.messages[2].content, TOOL_RESULT_ELIDED);
  assert.equal(result.savedChars, 400 - TOOL_RESULT_ELIDED.length, '省下的字符数如实记账');
});

test('P2-8 坏输入不抛：非数组 / 缺 content / 空历史', () => {
  assert.equal(elideOlderToolResults(null).elided, 0);
  assert.equal(elideOlderToolResults([], { budget: 0 }).elided, 0);
  assert.equal(elideOlderToolResults(undefined, { keepRounds: 0, budget: 0 }).elided, 0);
  const broken = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1' }, // 没有 content
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c2', content: 'z'.repeat(400) },
  ];
  const result = elideOlderToolResults(broken, { budget: 0, keepRounds: 0 });
  assert.equal(result.elided, 1, '缺 content 的那条跳过，不抛错');
  assert.equal(result.messages[1].content, undefined, '缺 content 的消息原样留着');
});
