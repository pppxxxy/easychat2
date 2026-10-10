// 持久化 agent 团队（.easychat/teams/<name>.md + run_team）测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TEAMS_DIR,
  TEAM_MAX_STEPS,
  parseTeamSteps,
  parseTeamMarkdown,
  workspaceTeamsSection,
  pickTeamFiles,
  readWorkspaceTeams,
  installSampleTeams,
  SAMPLE_TEAMS,
} from '../src/workspace/teams.js';
import { RUN_TEAM_TOOL_DEFINITION } from '../src/workspace/toolDefs/teamTool.js';

function makeStore(files = {}) {
  return {
    files,
    async listWorkspaceFiles({ subdir }) {
      const prefix = subdir ? `${subdir}/` : '';
      return Object.keys(files).filter(item => item.startsWith(prefix));
    },
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('fileNotFound');
      return { content: files[file] };
    },
    async writeWorkspaceFile({ path: file, content }) {
      files[file] = content;
      return { path: file };
    },
  };
}

test('parseTeamSteps：字段解析 / dependsOn / mode 归一 / 缺 id 补号 / 缺 task 跳过 / 上限', () => {
  const steps = parseTeamSteps([
    '- id: a | task: 调研 X | agent: researcher',
    '- task: 综合 | dependsOn: a, b | mode: write',
    '- id: skip-me',
    '- id: c | task: 第三 | mode: WEIRD',
  ].join('\n'));
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { id: 'a', task: '调研 X', agent: 'researcher', dependsOn: [], mode: 'read' });
  assert.equal(steps[1].id, 'step-2', '缺 id 自动补号');
  assert.deepEqual(steps[1].dependsOn, ['a', 'b']);
  assert.equal(steps[1].mode, 'write');
  assert.equal(steps[2].mode, 'read', '非法 mode 归一成 read');
  const many = parseTeamSteps(Array.from({ length: TEAM_MAX_STEPS + 3 }, (unused, i) => `- task: t${i}`).join('\n'));
  assert.equal(many.length, TEAM_MAX_STEPS);
});

test('parseTeamMarkdown：frontmatter / 缺省退化（文件名 + 正文首行）', () => {
  const full = parseTeamMarkdown([
    '---', 'name: 调研小组', 'description: 并行调研后综合', '---', '- task: 干活',
  ].join('\n'), 'fallback');
  assert.equal(full.name, '调研小组');
  assert.equal(full.description, '并行调研后综合');
  assert.equal(full.steps.length, 1);
  const bare = parseTeamMarkdown('先做这个\n- task: 干活', 'fallback');
  assert.equal(bare.name, 'fallback');
  assert.equal(bare.description, '先做这个');
});

test('workspaceTeamsSection：空列表不注入；清单含步数与 run_team 指引；超上限截断', () => {
  assert.equal(workspaceTeamsSection([]), '');
  assert.equal(workspaceTeamsSection(null), '');
  const section = workspaceTeamsSection([{ name: '调研', description: 'd', steps: [1, 2] }]);
  assert.ok(section.includes('调研') && section.includes('2 步') && section.includes('run_team'));
});

test('pickTeamFiles：只挑 .easychat/teams/<name>.md（跳过子目录与其它文件）', () => {
  assert.deepEqual(
    pickTeamFiles([`${TEAMS_DIR}/a.md`, `${TEAMS_DIR}/b.txt`, `${TEAMS_DIR}/sub/`, 'other.md']),
    [{ dirName: 'a', path: `${TEAMS_DIR}/a.md` }],
  );
});

test('readWorkspaceTeams：正常解析；目录不存在为空；坏文件只跳过它', async () => {
  const store = makeStore({ [`${TEAMS_DIR}/a.md`]: '---\nname: A\n---\n- task: t' });
  const teams = await readWorkspaceTeams(store, 'c');
  assert.equal(teams.length, 1);
  assert.equal(teams[0].name, 'A');
  assert.equal(teams[0].dirName, 'a');
  assert.equal((await readWorkspaceTeams(makeStore({}), 'c')).length, 0);
});

test('installSampleTeams：写入示例、幂等、绝不覆盖已有内容', async () => {
  const store = makeStore({});
  assert.equal(await installSampleTeams(store, 'c'), SAMPLE_TEAMS.length);
  assert.equal(await installSampleTeams(store, 'c'), 0, '幂等');
  const path0 = `${TEAMS_DIR}/${SAMPLE_TEAMS[0].fileName}.md`;
  store.files[path0] = '我改过了';
  assert.equal(await installSampleTeams(store, 'c'), 0);
  assert.equal(store.files[path0], '我改过了', '不覆盖用户内容');
});

test('run_team：缺 team / 找不到 / 无步骤报错；有步骤则按团队编排执行并合并结论', async () => {
  const noArg = await RUN_TEAM_TOOL_DEFINITION.execute({ store: makeStore({}) }, {}, {});
  assert.equal(noArg.isError, true);

  const missing = await RUN_TEAM_TOOL_DEFINITION.execute({ store: makeStore({}) }, { team: '不存在' }, {});
  assert.equal(missing.isError, true);

  const emptyTeam = makeStore({ [`${TEAMS_DIR}/x.md`]: '---\nname: X\n---\n（没有步骤）' });
  assert.equal((await RUN_TEAM_TOOL_DEFINITION.execute({ store: emptyTeam }, { team: 'X' }, {})).isError, true);

  // 有步骤：Node 里网络层不可达 → 每个子代理如实报不可用，但编排/合并结构成立。
  const store = makeStore({ [`${TEAMS_DIR}/x.md`]: '---\nname: X\n---\n- id: a | task: 干活' });
  const result = await RUN_TEAM_TOOL_DEFINITION.execute({ store }, { team: 'X' }, {});
  assert.ok(result.content.includes('步骤 a'), '按步骤 id 合并结论');
});

test('接线契约：ChatPanel 每轮直读团队并传入；设置面板可安装示例；i18n 中英齐', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('readWorkspaceTeams(storeRef.current, ownerId)'), '发消息时直读团队清单');
  assert.ok(panel.includes('installSampleTeams(storeRef.current, characterId)'), '安装示例接线');
  assert.ok(panel.includes('teams,'), 'teams 传进提示组装');

  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceSettingsSheet.js'), 'utf8');
  assert.ok(sheet.includes("id: 'teams'"), '设置面板有团队行');
  assert.ok(sheet.includes('onInstallSampleTeams'), '安装示例按钮接线');

  const tool = fs.readFileSync(path.resolve('src/workspace/toolDefs/teamTool.js'), 'utf8');
  assert.ok(tool.includes('loadPersistentBlackboard') && tool.includes('savePersistentBlackboard'), 'run_team 跨会话黑板接线');

  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  for (const key of ["'workspace.settings.teams'", "'workspace.settings.teams.hint'", "'workspace.settings.teams.install'"]) {
    assert.ok(zh.includes(key), `中文缺 ${key}`);
    assert.ok(en.includes(key), `英文缺 ${key}`);
  }
});
