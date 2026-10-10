// 工作区钩子（hooks.json，声明式）测试（spec: 2026-10-09-agent-extensibility T6）。
//
// 覆盖：① 解析容错（非 JSON / 畸形条目 / 键名宽容 / 上限）；② before_shell 词边界命中
// 与 deny 规则翻译（与 T3 求值链路的集成）；③ after_* 路径 glob 通知；
// ④ 读文件三态；⑤ 接线契约（两页注入 extraRules、工具层追加通知、i18n）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluatePermissionRules } from '../src/agent/permissions.js';
import {
  DEFAULT_HOOKS,
  HOOKS_FILE,
  HOOKS_MAX_PER_EVENT,
  HOOK_EVENTS,
  HOOK_NOTICES_MAX,
  HOOK_SHELL_EFFECTS,
  collectCompactionHooks,
  collectPostEventNotices,
  collectPromptHooks,
  collectSessionStartNotices,
  collectToolResultNotices,
  collectTurnEndNotices,
  hookPermissionRules,
  matchBeforeShellHooks,
  matchBeforeToolHooks,
  matchHookText,
  matchToolName,
  parseWorkspaceHooks,
  readWorkspaceHooks,
  validateWorkspaceHooks,
  withDefaultHooks,
} from '../src/workspace/hooks.js';

const SAMPLE = {
  before_shell: [{ match: 'git push', message: '推送由用户手动执行' }],
  after_write: [{ glob: '**/*.md', message: '检查目录与链接是否同步' }],
  after_edit: [{ glob: 'src/**/*.js', message: '记得跑测试' }],
};

function makeStore(files = {}) {
  return {
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('fileNotFound');
      return { content: files[file] };
    },
  };
}

test('parseWorkspaceHooks：正常解析；非 JSON / 非对象 / 畸形条目一律安全降级', () => {
  const parsed = parseWorkspaceHooks(JSON.stringify(SAMPLE));
  assert.equal(parsed.before_shell.length, 1);
  assert.equal(parsed.after_write[0].message, '检查目录与链接是否同步');

  // 键缺失 = 没提过（不是「显式为空」）：结果里不出现该键，交给合并层决定是否补默认（A4）
  assert.deepEqual(parseWorkspaceHooks('{不是 json'), {});
  assert.deepEqual(parseWorkspaceHooks('[]'), {});
  assert.deepEqual(parseWorkspaceHooks(null), {});
  // 显式空数组要保留——它是「同键关闭默认提醒」的语义载体
  assert.deepEqual(parseWorkspaceHooks({ after_edit: [] }), { after_edit: [] });
  // 值写坏了（不是数组）当缺失处理：不因手误关掉默认
  assert.equal('after_edit' in parseWorkspaceHooks({ after_edit: 'oops' }), false);

  // 缺 match 或 message 的条目被剔除；两个键名（match/glob）都认
  const tolerant = parseWorkspaceHooks({
    before_shell: [
      { message: '没有匹配串' },
      { match: 'rm -rf' },
      { match: '  docker  ', message: '  禁  ' },
    ],
    after_write: [{ glob: 'a.md', message: 'ok' }],
  });
  assert.deepEqual(tolerant.before_shell, [{ pattern: 'docker', message: '禁', effect: 'deny' }]);
  assert.equal(tolerant.after_write[0].pattern, 'a.md');

  // 上限：每事件最多 HOOKS_MAX_PER_EVENT 条
  const many = { before_shell: Array.from({ length: HOOKS_MAX_PER_EVENT + 5 }, (unused, i) => ({ match: `cmd${i}`, message: 'x' })) };
  assert.equal(parseWorkspaceHooks(many).before_shell.length, HOOKS_MAX_PER_EVENT);
});

test('before_shell：词边界命中（不放行前缀更长的另一条命令），翻译成 deny 规则走 T3 求值链路', () => {
  const hooks = parseWorkspaceHooks(SAMPLE);
  assert.equal(matchBeforeShellHooks(hooks, 'git push origin main').length, 1);
  assert.equal(matchBeforeShellHooks(hooks, 'git pushx').length, 0, '词边界:pushx 不是 push');
  assert.equal(matchBeforeShellHooks(hooks, 'ls').length, 0);
  assert.equal(matchBeforeShellHooks(null, 'ls').length, 0);

  const rules = hookPermissionRules(hooks);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].effect, 'deny');
  assert.equal(rules[0].tool, 'run_shell');
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'git push --force' } }),
    'deny',
    '钩子禁令必须能通过既有 deny 链路裁决'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'git status' } }),
    null,
    '没命中的命令照常走弹框'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'write_workspace_file', args: { path: 'a.md' } }),
    null,
    '钩子只锁 run_shell，不影响别的工具'
  );
});

test('before_shell 的 effect：ask 走「必须先问」链路；写 allow / 写错一律收紧成 deny', () => {
  // P0-6 的第二个创建入口：用户在 hooks.json 里写出「git push 必须先问」。
  const hooks = parseWorkspaceHooks({
    before_shell: [
      { match: 'git push', message: '推送先问我', effect: 'ask' },
      { match: 'rm -rf', message: '删除先问我', effect: 'ask' },
      { match: 'curl', message: '外发禁止' },
      { match: 'npm publish', message: '写 allow 想放宽', effect: 'allow' },
      { match: 'wget', message: 'effect 写错', effect: 'maybe' },
    ],
  });
  assert.deepEqual(
    hooks.before_shell.map(item => item.effect),
    ['ask', 'ask', 'deny', 'deny', 'deny'],
    '缺省 deny；显式 ask 保留；allow 与拼错一律收紧成 deny（声明式钩子只能收紧不能放宽）'
  );

  const rules = hookPermissionRules(hooks);
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'git push origin main' } }),
    'ask',
    'ask 档必须能被既有求值链路识别（调用方据此只给「允许这一次」）'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'curl https://x' } }),
    'deny'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'npm publish' } }),
    'deny',
    'hooks.json 里写 allow 不能放宽授权'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'ls' } }),
    null
  );

  // 与存储里的宽 allow 并存时，钩子 ask 必须压过它（否则例外形同虚设）。
  const storedAllow = [{ effect: 'allow', tool: 'run_shell', match: 'git', scope: 'always' }];
  assert.equal(
    evaluatePermissionRules([...rules, ...storedAllow], { tool: 'run_shell', args: { command: 'git push' } }),
    'ask',
    'ask 压过 allow：这正是「放行 git 但 git push 必须先问」的表达'
  );

  // 白名单本身不含 allow（这是「只能收紧」的机器可读形式）。
  assert.deepEqual([...HOOK_SHELL_EFFECTS], ['deny', 'ask']);

  // after_* 条目不该被塞上 effect（那是 shell 专属语义）。
  const mixed = parseWorkspaceHooks({
    after_write: [{ glob: '**/*.md', message: 'x', effect: 'ask' }],
  });
  assert.equal('effect' in mixed.after_write[0], false);
});

test('after_* 通知：按路径 glob 命中；事件名不合法返回空', () => {
  const hooks = parseWorkspaceHooks(SAMPLE);
  assert.deepEqual(collectPostEventNotices(hooks, 'after_write', 'docs/readme.md'), ['检查目录与链接是否同步']);
  assert.deepEqual(collectPostEventNotices(hooks, 'after_write', 'src/a.js'), [], 'after_write 归 after_write');
  assert.deepEqual(collectPostEventNotices(hooks, 'after_edit', 'src/lib/a.js'), ['记得跑测试']);
  assert.deepEqual(collectPostEventNotices(hooks, 'before_shell', 'src/a.js'), []);
  assert.deepEqual(collectPostEventNotices(null, 'after_write', 'a.md'), []);
});

test('readWorkspaceHooks：文件不存在 / 读失败 / 坏格式一律空结构（绝不抛错）', async () => {
  const hooks = await readWorkspaceHooks(makeStore({ [HOOKS_FILE]: JSON.stringify(SAMPLE) }), 'c1');
  assert.equal(hooks.before_shell.length, 1);

  // 读失败 / 文件不存在 / 坏格式 → 只剩内置默认（A4）：before_shell 无默认，after_* 有默认提醒
  const bare = await readWorkspaceHooks(makeStore({}), 'c1');
  assert.equal(bare.before_shell, undefined, 'before_shell 没有默认（键缺失语义）');
  assert.equal(bare.after_edit.length, 1, '缺文件 → 默认验证提醒生效');
  const broken = await readWorkspaceHooks(makeStore({ [HOOKS_FILE]: '}}' }), 'c1');
  assert.equal(broken.after_write.length, 1, '坏格式 → 默认仍在（文件坏了不该关掉默认）');
  const none = await readWorkspaceHooks(null, 'c1');
  assert.equal(none.after_edit.length, 1);
});

test('D4-1 on_tool_result：工具名精确匹配（前缀不算命中）；坏输入安全；可经 hooks.json 解析', () => {
  const hooks = {
    on_tool_result: [
      { pattern: 'run_shell', message: '记得核对退出码' },
      { pattern: 'read_workspace_file', message: '大文件注意分页' },
      { pattern: 'run_shell', message: '第二条' },
    ],
  };
  assert.deepEqual(collectToolResultNotices(hooks, 'run_shell'), ['记得核对退出码', '第二条'], '多条按声明顺序');
  assert.deepEqual(collectToolResultNotices(hooks, 'read_workspace_file'), ['大文件注意分页']);
  assert.deepEqual(collectToolResultNotices(hooks, 'run_shell_extra'), [], '精确匹配——前缀不算命中');
  assert.deepEqual(collectToolResultNotices(hooks, 'unknown'), []);
  assert.deepEqual(collectToolResultNotices(null, 'run_shell'), []);
  assert.deepEqual(collectToolResultNotices(hooks, ''), [], '空工具名不命中');

  // 经 hooks.json 解析（事件白名单已含 on_tool_result；条目用 match 字段）
  const parsed = parseWorkspaceHooks({ on_tool_result: [{ match: 'run_shell', message: 'm' }] });
  assert.deepEqual(collectToolResultNotices(parsed, 'run_shell'), ['m']);
});

test('A4 内置验证提醒：默认生效；同键（含空数组）可覆盖；只覆盖声明的键', async () => {
  // 用户只配了别的键 → after_* 默认仍在
  const withShell = await readWorkspaceHooks(
    makeStore({ [HOOKS_FILE]: JSON.stringify({ before_shell: [{ match: 'x', message: 'y' }] }) }),
    'c1'
  );
  assert.equal(collectPostEventNotices(withShell, 'after_write', 'a.md').length, 1, '未声明的键 → 默认生效');
  assert.equal(collectPostEventNotices(withShell, 'after_edit', 'src/a.js').length, 1);

  // 显式空数组 → 关闭该键的默认
  const off = await readWorkspaceHooks(makeStore({ [HOOKS_FILE]: JSON.stringify({ after_edit: [] }) }), 'c1');
  assert.deepEqual(collectPostEventNotices(off, 'after_edit', 'src/a.js'), [], '空数组关闭 after_edit 默认');
  assert.equal(collectPostEventNotices(off, 'after_write', 'a.md').length, 1, '只关闭声明的那个键');

  // 用户自定义同键 → 用用户的（默认不叠加）
  const custom = await readWorkspaceHooks(
    makeStore({ [HOOKS_FILE]: JSON.stringify({ after_edit: [{ glob: 'src/**', message: '跑测试' }] }) }),
    'c1'
  );
  assert.deepEqual(collectPostEventNotices(custom, 'after_edit', 'src/a.js'), ['跑测试'], '同键用用户的');
  assert.deepEqual(collectPostEventNotices(custom, 'after_edit', 'docs/a.md'), [], '用户声明后默认不再兜底');

  // 纯函数直接钉：合并只补缺失键
  assert.deepEqual(withDefaultHooks({}), DEFAULT_HOOKS);
  assert.deepEqual(withDefaultHooks({ after_edit: [] }).after_edit, [], '空数组不被默认覆盖');
  assert.deepEqual(withDefaultHooks(null).before_shell, undefined, '默认里没有 before_shell');
});

test('接线契约：两页审批注入 extraRules；工具层追加通知；设置面板说明行；i18n 中英齐', () => {
  const flow = fs.readFileSync(path.resolve('src/chat/toolApprovalFlow.js'), 'utf8');
  assert.ok(flow.includes('extraRules'), 'approveToolCall 支持注入规则');
  assert.ok(flow.includes('evaluatePermissionRules(injected'), '存储读失败时注入的钩子规则仍参与求值');

  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('readWorkspaceHooks(storeRef.current, characterId)'), '工作区页每次审批直读钩子');
  assert.ok(panel.includes('extraRules,'), 'extraRules 传进审批');

  const chat = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  assert.ok(chat.includes('readWorkspaceHooks(hookStore, character.id)'), '聊天页审批同样注入钩子禁令');

  // 写工具定义已按域拆到 toolDefs/writeTools.js（质量建议 ①），断言跟着去新文件。
  const tools = fs.readFileSync(path.resolve('src/workspace/toolDefs/writeTools.js'), 'utf8');
  assert.ok(tools.includes("'after_write'"), '写文件工具接 after_write');
  assert.ok(tools.includes("'after_edit'"), '编辑工具接 after_edit');
  assert.ok(tools.includes('[工作区钩子]'), '通知追加进工具结果（模型可见）');

  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceSettingsSheet.js'), 'utf8');
  assert.ok(sheet.includes("id: 'hooks'"), '设置面板有钩子说明行');

  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  assert.ok(zh.includes("'workspace.settings.hooks.hint'"));
  assert.ok(en.includes("'workspace.settings.hooks.hint'"));
});

test('安全边界登记：模块注释明确「不执行任意脚本」（防未来顺手加 eval）', () => {
  const source = fs.readFileSync(path.resolve('src/workspace/hooks.js'), 'utf8');
  assert.ok(source.includes('零代码执行'), '必须写明设计底线');
  assert.equal(/eval\(|new Function\(/.test(source), false, '钩子模块不得出现任何动态执行原语');
});

// ---------- P0-8：事件面扩展（before_tool / before_prompt / before_compact / after_turn / session_start） ----------

test('P0-8 事件面：九个事件都在白名单里（新增事件必须同时进 HOOK_EVENTS 与文档）', () => {
  assert.deepEqual([...HOOK_EVENTS], [
    'before_shell',
    'before_tool',
    'before_prompt',
    'before_compact',
    'after_turn',
    'session_start',
    'after_write',
    'after_edit',
    'on_tool_result',
  ]);
});

test('P0-8 matchToolName：精确 / `|` 列表 / `*` / `re:` 正则；坏正则不匹配（绝不静默放行）', () => {
  assert.equal(matchToolName('run_shell', 'run_shell'), true);
  assert.equal(matchToolName('run_shell', 'run_python'), false);
  assert.equal(matchToolName('run_shell|run_python', 'run_python'), true);
  assert.equal(matchToolName(' run_shell | run_python ', 'run_shell'), true, '两侧空白容忍');
  assert.equal(matchToolName('*', 'anything'), true);
  assert.equal(matchToolName('', 'anything'), true, '空 = 全部（与 `*` 同义）');
  assert.equal(matchToolName('re:^write_', 'write_workspace_file'), true);
  assert.equal(matchToolName('re:^write_', 'read_workspace_file'), false);
  assert.equal(matchToolName('re:[', 'write_workspace_file'), false, '坏正则匹配不上而不是抛错');
  assert.equal(matchToolName('run_shell', ''), false);
});

test('P0-8 matchHookText：空/`*` 全命中、子串命中、`re:` 命中、坏正则不命中', () => {
  assert.equal(matchHookText('', '随便什么'), true);
  assert.equal(matchHookText('*', '随便什么'), true);
  assert.equal(matchHookText('部署', '帮我部署到线上'), true);
  assert.equal(matchHookText('部署', '帮我上线'), false);
  assert.equal(matchHookText('re:^(写|改)', '写一个测试'), true);
  assert.equal(matchHookText('re:^(写|改)', '看一下测试'), false);
  assert.equal(matchHookText('re:[', '任意文本'), false);
});

test('P0-8 before_tool：工具名 + 参数（命令前缀 / 路径 glob / 工具级），deny/ask 走同一条求值链路', () => {
  const hooks = parseWorkspaceHooks({
    before_tool: [
      { tool: 'run_shell|run_python', match: 'rm -rf', message: '删除先问我', effect: 'ask' },
      { tool: 'write_workspace_file', match: 'src/**', message: 'src 下不许写', effect: 'deny' },
      { tool: 're:^read_', message: '读操作也要先问', effect: 'ask' },
      { tool: 'run_shell', match: 'curl', message: '外发禁止' },
      { message: '缺 tool 的条目' },
      { tool: 'run_shell', match: 'npm publish', message: '写 allow 想放宽', effect: 'allow' },
    ],
  });
  assert.equal(hooks.before_tool.length, 5, '缺 tool 的条目被剔除');
  assert.deepEqual(
    hooks.before_tool.map(item => item.effect),
    ['ask', 'deny', 'ask', 'deny', 'deny'],
    '缺省 deny；显式 ask 保留；写 allow 一律收紧成 deny'
  );
  assert.equal(matchBeforeToolHooks(hooks, 'write_workspace_file').length, 1);
  assert.equal(matchBeforeToolHooks(hooks, 'read_workspace_file').length, 1, 're: 命中读工具');

  const rules = hookPermissionRules(hooks);
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_python', args: { code: 'rm -rf /' } }),
    'ask',
    'code 参数同样按前缀语义匹配（字段驱动，不硬编码工具名）'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'write_workspace_file', args: { path: 'src/lib/a.js' } }),
    'deny'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'write_workspace_file', args: { path: 'docs/a.md' } }),
    null,
    '没命中的路径照常走弹框'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'read_workspace_file', args: { path: 'a.md' } }),
    'ask',
    '工具级规则（无 match）= 该工具全部调用'
  );
  assert.equal(
    evaluatePermissionRules(rules, { tool: 'run_shell', args: { command: 'npm publish' } }),
    'deny',
    'hooks.json 里写 allow 不能放宽授权'
  );
  // before_shell 与 before_tool 一起翻译，顺序不影响求值（优先级是语义）。
  const mixed = hookPermissionRules(parseWorkspaceHooks({
    before_shell: [{ match: 'git push', message: '推送先问我', effect: 'ask' }],
    before_tool: [{ tool: 'run_shell', match: 'git', message: '禁止 git', effect: 'deny' }],
  }));
  assert.equal(evaluatePermissionRules(mixed, { tool: 'run_shell', args: { command: 'git push' } }), 'deny',
    'deny 仍压过 ask（安全不回退）');
});

test('P0-8 before_prompt：默认注入、显式 deny 拦下这次发送；注入有条数上限', () => {
  const hooks = parseWorkspaceHooks({
    before_prompt: [
      { match: '部署', message: '本项目禁止自动部署', effect: 'deny' },
      { match: 're:^(写|改)', message: '先读 AGENTS.md 再动手' },
      { match: '', message: '每次都提醒：用中文回答' },
      { match: '写', message: '第二条注入' },
    ],
  });
  const blocked = collectPromptHooks(hooks, '帮我部署到线上');
  assert.deepEqual(blocked.blocks, ['本项目禁止自动部署'], 'deny 优先返回理由');
  assert.deepEqual(blocked.notices, ['每次都提醒：用中文回答'], '同一条输入命中的注入也一并返回（调用方按 blocks 决定是否发送）');

  const injected = collectPromptHooks(hooks, '写一个测试');
  assert.deepEqual(injected.blocks, []);
  assert.deepEqual(injected.notices, ['先读 AGENTS.md 再动手', '每次都提醒：用中文回答', '第二条注入']);

  const none = collectPromptHooks(hooks, '今天天气不错');
  assert.deepEqual(none.notices, ['每次都提醒：用中文回答'], '空 match = 每次注入');
  assert.deepEqual(collectPromptHooks(null, 'x'), { blocks: [], notices: [] });

  // 上限：一个钩子文件不该能把上下文撑爆。
  const many = parseWorkspaceHooks({
    before_prompt: Array.from({ length: HOOK_NOTICES_MAX + 3 }, (unused, i) => ({ message: `n${i}` })),
  });
  assert.equal(collectPromptHooks(many, 'x').notices.length, HOOK_NOTICES_MAX);
});

test('P0-8 before_compact / after_turn / session_start：注入文字收集（压缩可拦）', () => {
  const hooks = parseWorkspaceHooks({
    before_compact: [
      { message: '保留所有未决问题与报错原文' },
      { match: '别压缩', message: '这次先不压缩', effect: 'deny' },
    ],
    after_turn: [{ message: '把结论写进工作区 AGENTS.md' }],
    session_start: [{ message: '本次会话请用中文回答' }],
  });
  const compact = collectCompactionHooks(hooks, '普通压缩');
  assert.deepEqual(compact.notices, ['保留所有未决问题与报错原文']);
  assert.deepEqual(compact.blocks, []);
  const refused = collectCompactionHooks(hooks, '别压缩');
  assert.deepEqual(refused.blocks, ['这次先不压缩']);
  assert.deepEqual(collectTurnEndNotices(hooks), ['把结论写进工作区 AGENTS.md']);
  assert.deepEqual(collectSessionStartNotices(hooks), ['本次会话请用中文回答']);
  assert.deepEqual(collectTurnEndNotices(null), []);
  assert.deepEqual(collectSessionStartNotices({}), []);
});

test('P0-8 validateWorkspaceHooks：坏 JSON / 未知事件 / 非数组 / 无效条目 / 坏正则 / 超量都报出来', () => {
  assert.deepEqual(validateWorkspaceHooks('{坏 json'), { ok: false, errors: [{ event: '', index: -1, reason: 'invalid-json' }] });
  assert.deepEqual(validateWorkspaceHooks('[]'), { ok: false, errors: [{ event: '', index: -1, reason: 'not-object' }] });

  const result = validateWorkspaceHooks({
    before_shell: [{ match: 'git push', message: 'ok' }],
    nonsense: [{ message: 'x' }],
    after_write: 'oops',
    before_tool: [{ message: '缺 tool' }, { tool: 're:[', message: '坏正则' }],
    before_prompt: Array.from({ length: HOOKS_MAX_PER_EVENT + 2 }, (unused, i) => ({ message: `n${i}` })),
  });
  assert.equal(result.ok, false);
  const reasons = result.errors.map(item => `${item.event}:${item.reason}`);
  assert.ok(reasons.includes('nonsense:unknown-event'));
  assert.ok(reasons.includes('after_write:not-array'));
  assert.ok(reasons.includes('before_tool:invalid-item'));
  assert.ok(reasons.includes('before_tool:invalid-regex'));
  assert.ok(reasons.includes('before_prompt:too-many'));

  // 通过校验 = 一定解析得出来（两边共用同一套归一）。
  const good = {
    before_shell: [{ match: 'git push', message: 'ok' }],
    before_tool: [{ tool: 'run_shell', match: 'rm', message: 'ok', effect: 'ask' }],
    before_prompt: [{ match: 're:^部署', message: 'ok', effect: 'deny' }],
    before_compact: [{ message: 'ok' }],
    after_turn: [{ message: 'ok' }],
    session_start: [{ message: 'ok' }],
    after_write: [{ glob: '**/*.md', message: 'ok' }],
    after_edit: [{ glob: 'src/**', message: 'ok' }],
    on_tool_result: [{ match: 'run_shell', message: 'ok' }],
  };
  assert.deepEqual(validateWorkspaceHooks(good), { ok: true, errors: [] });
  const parsed = parseWorkspaceHooks(good);
  assert.equal(Object.keys(parsed).length, 9, '九个事件全部解析出来');
});
