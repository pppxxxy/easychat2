// E3 分身档案测试：纯函数（frontmatter 解析 / 清单段 / 文件挑选）+ IO（fake store）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MAX_ROUNDS_LIMIT,
  AGENTS_DIR,
  parseAgentMarkdown,
  pickAgentFiles,
  readWorkspaceAgents,
  workspaceAgentsSection,
} from '../src/workspace/agents.js';

test('E3 parseAgentMarkdown：四字段解析 + tools 只收只读白名单（含防递归）', () => {
  const profile = parseAgentMarkdown([
    '---',
    'name: 架构审查员',
    'description: 只看架构与依赖，不碰实现细节',
    'tools: read_workspace_file, run_subagent, write_workspace_file, list_workspace_files',
    'max-rounds: 9',
    '---',
    '正文随便写。',
  ].join('\n'), 'fallback');
  assert.equal(profile.name, '架构审查员');
  assert.equal(profile.description, '只看架构与依赖，不碰实现细节');
  assert.deepEqual(
    profile.tools,
    ['list_workspace_files', 'read_workspace_file'],
    '∩ 只读白名单：run_subagent（防递归）与 write 类被物理丢弃'
  );
  assert.equal(profile.maxRounds, 9);

  // max-rounds clamp：写 100 收敛到上限；写 0 / 非数字当没写
  assert.equal(parseAgentMarkdown('---\nmax-rounds: 100\n---\n', 'a').maxRounds, AGENT_MAX_ROUNDS_LIMIT);
  assert.equal('maxRounds' in parseAgentMarkdown('---\nmax-rounds: 0\n---\n', 'a'), false);
  assert.equal('maxRounds' in parseAgentMarkdown('---\nmax-rounds: x\n---\n', 'a'), false);

  // 无 frontmatter 退化：name 用文件名、description 取正文第一个有效行
  const bare = parseAgentMarkdown('第一行就是描述\n第二行', 'fast-reader');
  assert.equal(bare.name, 'fast-reader');
  assert.equal(bare.description, '第一行就是描述');
  assert.equal('tools' in bare, false, '不写 tools = 全量只读白名单（不是空工具表）');
});

test('E3 workspaceAgentsSection：排序稳定、空列表空串、轮次如实展示', () => {
  assert.equal(workspaceAgentsSection([]), '');
  assert.equal(workspaceAgentsSection(null), '');
  const section = workspaceAgentsSection([
    { name: 'b-agent', description: 'B' },
    { name: 'a-agent', description: 'A', maxRounds: 4 },
  ]);
  assert.ok(section.includes('2 个分身'), '如实报数');
  const aAt = section.indexOf('a-agent');
  const bAt = section.indexOf('b-agent');
  assert.ok(aAt > 0 && bAt > aAt, '按名字排序（清单稳定可比，缓存前缀才稳）');
  assert.ok(section.includes('（4 轮上限）'), '自定义轮次如实展示');
  assert.ok(section.includes('run_subagent'), '写明用哪个参数选用');
});

test('E3 pickAgentFiles：只收一级 .md（子目录/非 md/目录条目都排除）', () => {
  const files = pickAgentFiles([
    `${AGENTS_DIR}/one.md`,
    `${AGENTS_DIR}/two.md`,
    `${AGENTS_DIR}/sub/three.md`,
    `${AGENTS_DIR}/notes.txt`,
    `${AGENTS_DIR}/`,
    'other/one.md',
  ]);
  assert.deepEqual(files.map(item => item.name), ['one', 'two']);
});

test('E3 readWorkspaceAgents：fake store 往返 + 坏文件跳过 + 按名字过滤', async () => {
  const store = {
    async listWorkspaceFiles() {
      return [`${AGENTS_DIR}/fast-reader.md`, `${AGENTS_DIR}/broken.md`, `${AGENTS_DIR}/sub/ignored.md`];
    },
    async readWorkspaceFile({ path }) {
      if (path.endsWith('broken.md')) throw new Error('io fail');
      return {
        content: '---\nname: 快读者\ndescription: 快速定位\ntools: read_workspace_file\n---\n',
      };
    },
  };
  const all = await readWorkspaceAgents(store, 'c1');
  assert.equal(all.length, 1, '一个坏档案只跳过它自己，整张清单不消失');
  assert.equal(all[0].name, '快读者');
  assert.deepEqual(all[0].tools, ['read_workspace_file']);

  const picked = await readWorkspaceAgents(store, 'c1', ['FAST-READER']);
  assert.equal(picked.length, 1, '按名字过滤（大小写不敏感）');
  assert.equal((await readWorkspaceAgents(store, 'c1', ['nope'])).length, 0);

  // 无 store / list 失败：安全返回空（不抛错——清单是旁路机制）
  assert.deepEqual(await readWorkspaceAgents(null, 'c1'), []);
  assert.deepEqual(
    await readWorkspaceAgents({ async listWorkspaceFiles() { throw new Error('x'); } }, 'c1'),
    []
  );
});
