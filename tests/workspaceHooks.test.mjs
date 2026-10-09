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
  collectPostEventNotices,
  collectToolResultNotices,
  matchBeforeShellHooks,
  parseWorkspaceHooks,
  readWorkspaceHooks,
  shellHookDenyRules,
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
  assert.deepEqual(tolerant.before_shell, [{ pattern: 'docker', message: '禁' }]);
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

  const rules = shellHookDenyRules(hooks);
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
