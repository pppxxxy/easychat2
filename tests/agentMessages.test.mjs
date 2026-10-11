// D2 工具结果头尾保留截断测试（agent/messages.js serializeToolResult）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPersistedToolResult,
  serializeToolResult,
  serializeToolResultAsync,
  TOOL_RESULT_LIMIT,
  TOOL_RESULT_PREVIEW_CHARS,
} from '../src/agent/messages.js';

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

test('O1 formatPersistedToolResult：头尾预览 + 省略标注 + 指针', () => {
  const content = `${'H'.repeat(3000)}${'M'.repeat(5000)}${'T'.repeat(3000)}`;
  const text = formatPersistedToolResult(content, '.task_outputs/tool-results/x.txt');
  assert.match(text, /^H{2000}/);
  assert.match(text, /T{2000}$|T{2000}/);
  assert.match(text, /中间省略 \d+ 字符/);
  assert.match(text, /\.task_outputs\/tool-results\/x\.txt/);
  assert.ok(text.length < content.length, '替换后显著短于原文');
  assert.equal(TOOL_RESULT_PREVIEW_CHARS, 2000);
});

test('O1 serializeToolResultAsync：未超限原样；超限落盘则带指针；persist 失败退回头尾', async () => {
  // 未超限
  assert.equal(await serializeToolResultAsync('short', { limit: 100 }), 'short');

  // 超限 + persist 成功 → 预览 + 指针
  const big = 'x'.repeat(500);
  const persisted = await serializeToolResultAsync({ content: big }, {
    limit: 100,
    toolName: 'run_shell',
    toolCallId: 'c1',
    persist: async () => ({ path: '.task_outputs/tool-results/c1.txt' }),
  });
  assert.match(persisted, /\.task_outputs\/tool-results\/c1\.txt/);

  // 超限 + 无 persist → D2 头尾保留（无指针）
  const fallback = await serializeToolResultAsync(big, { limit: 100, toolName: 'run_shell' });
  assert.equal(/\.task_outputs\//.test(fallback), false);
  assert.match(fallback, /中间省略/);

  // 超限 + persist 抛错 → 退回头尾保留
  const errored = await serializeToolResultAsync(big, {
    limit: 100,
    toolName: 'run_shell',
    persist: async () => { throw new Error('disk'); },
  });
  assert.match(errored, /中间省略/);
});
