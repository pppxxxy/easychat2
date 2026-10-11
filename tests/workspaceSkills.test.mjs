// 工作区技能（SKILL.md 渐进披露）测试（spec: 2026-10-09-agent-extensibility T4）。
//
// 覆盖：① 解析（frontmatter / 无元数据退化 / 畸形）；② 清单注入（三态与上限）；
// ③ 目录扫描与单坏文件隔离；④ 示例安装幂等且不覆盖；⑤ 提示词集成（ask 不注入）；
// ⑥ 接线契约与 i18n 中英。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildWorkspaceAgentSystemPrompt } from '../src/workspace/chat.js';
import {
  SAMPLE_SKILLS,
  SKILLS_DIR,
  SKILL_ALLOWED_TOOLS_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_NAME,
  SKILL_LIST_MAX,
  installSampleSkills,
  parseSkillMarkdown,
  pickSkillFiles,
  readWorkspaceSkills,
  workspaceSkillsSection,
} from '../src/workspace/skills.js';

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

test('parseSkillMarkdown：frontmatter 解析、引号剥离、无元数据退化、畸形不崩', () => {
  const full = parseSkillMarkdown([
    '---',
    'name: 周报整理',
    'description: 把零散进展整理成周报',
    '---',
    '',
    '# 周报',
    '步骤一',
  ].join('\n'), 'weekly-report');
  assert.equal(full.name, '周报整理');
  assert.equal(full.description, '把零散进展整理成周报');

  const quoted = parseSkillMarkdown('---\nname: "quoted-name"\ndescription: \'单引号\'\n---\n正文', 'x');
  assert.equal(quoted.name, 'quoted-name');
  assert.equal(quoted.description, '单引号');

  // 无 frontmatter：名字退化为目录名，描述取第一个非空、非标题/引用行
  const plain = parseSkillMarkdown('# 标题\n\n> 引用\n\n真正的第一段\n第二行', 'my-skill');
  assert.equal(plain.name, 'my-skill');
  assert.equal(plain.description, '真正的第一段');

  // 未闭合的 --- 当普通正文处理（不能把整份文件吞掉）
  const malformed = parseSkillMarkdown('---\nname: x\n没有闭合', 'fb');
  assert.equal(malformed.name, 'fb');
  assert.equal(malformed.description, '---');

  // 描述超长截断
  const long = parseSkillMarkdown(`---\ndescription: ${'x'.repeat(400)}\n---\n`, 'n');
  assert.equal(long.description.length, SKILL_DESCRIPTION_MAX);

  assert.deepEqual(parseSkillMarkdown(null, 'fb'), { name: 'fb', description: '' });
});

test('workspaceSkillsSection：空列表不注入；清单含路径指引；超上限截断并说明', () => {
  assert.equal(workspaceSkillsSection([]), '');
  assert.equal(workspaceSkillsSection(null), '');
  assert.equal(workspaceSkillsSection([{ description: '没有名字' }]), '', '没名字的条目不算技能');

  const section = workspaceSkillsSection([{ name: 'weekly-report', description: '周报整理' }]);
  assert.ok(section.includes('weekly-report'));
  assert.ok(section.includes('周报整理'));
  assert.ok(section.includes(SKILLS_DIR), '要写明技能存放目录');
  assert.ok(section.includes('read_workspace_file'), '要指引模型用现有工具读全文');

  const many = Array.from({ length: SKILL_LIST_MAX + 5 }, (unused, index) => ({ name: `s${index}`, description: 'd' }));
  const capped = workspaceSkillsSection(many);
  assert.ok(capped.includes('还有 5 个'), '超出上限如实报数（D1）');
  assert.ok(capped.includes('list_workspace_files'), '给出查看全部的方法');
  // D1：按名字排序截断——清单稳定可比（顺序不依赖文件枚举）
  const sortedAll = [...many].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  assert.ok(capped.includes(`- ${sortedAll[0].name}：`), '排序后第一项在清单里');
  for (const item of sortedAll.slice(SKILL_LIST_MAX)) {
    assert.equal(capped.includes(`- ${item.name}：`), false, `${item.name} 超出上限不列`);
  }
});

test('D1 allowed-tools：解析（含下划线兼容/上限）+ 清单注入；缺 name 用目录名；超长 description 截断', () => {
  // 标准字段解析
  const parsed = parseSkillMarkdown([
    '---',
    'name: 周报整理',
    'description: 把进展整理成周报',
    'allowed-tools: read_workspace_file, write_workspace_file, run_python',
    '---',
    '# 流程',
  ].join('\n'), 'fallback');
  assert.deepEqual(parsed.allowedTools, ['read_workspace_file', 'write_workspace_file', 'run_python']);
  // 下划线兼容（部分生成器产出）+ 上限收敛
  const snake = parseSkillMarkdown('---\nallowed_tools: a, b\n---\n正文', 'x');
  assert.deepEqual(snake.allowedTools, ['a', 'b']);
  const capped = parseSkillMarkdown(`---\nallowed-tools: ${Array.from({ length: 12 }, (unused, i) => `t${i}`).join(', ')}\n---\n正文`, 'x');
  assert.equal(capped.allowedTools.length, SKILL_ALLOWED_TOOLS_MAX, '注入行要收着点');
  // 没有该字段 → 不产生 allowedTools（清单不注入建议工具行）
  assert.equal('allowedTools' in parseSkillMarkdown('---\nname: x\n---\n正文', 'x'), false);

  // 清单注入：建议工具一行可见（软约束——执行门仍走 registry）
  const section = workspaceSkillsSection([{
    name: '周报整理',
    description: '把进展整理成周报',
    allowedTools: ['read_workspace_file', 'run_python'],
  }]);
  assert.ok(section.includes('建议工具：read_workspace_file, run_python'), 'D1：软约束注入');

  // 任务书 D1.6：缺 name 退化目录名；超长 description 截断
  const noName = parseSkillMarkdown('---\ndescription: 只有描述\n---\n正文', 'dir-name');
  assert.equal(noName.name, 'dir-name');
  const longDesc = parseSkillMarkdown(`---\nname: x\n---\n${'长'.repeat(400)}`, 'x');
  assert.ok(longDesc.description.length <= SKILL_DESCRIPTION_MAX, '超长 description 截断');
  assert.ok(longDesc.description.endsWith('…'));
});

test('D1 资源文件：技能目录下的 scripts/templates 走同一条 read 通路（无特殊过滤，天然可读）', async () => {
  // 社区技能包的第 3 层披露：SKILL.md 正文相对引用 ./scripts/x.py、./templates/x.md。
  // 它们就是工作区普通文本文件——这里把「同一条 read 通路」钉住，防未来有人给
  // skills 目录加特殊过滤（那会悄悄破坏整个技能生态）。
  const files = {
    [`${SKILLS_DIR}/weekly-report/${SKILL_FILE_NAME}`]: '# 技能',
    [`${SKILLS_DIR}/weekly-report/scripts/gen.py`]: 'print("gen")',
    [`${SKILLS_DIR}/weekly-report/templates/report.md`]: '# 模板',
  };
  // 动态 import：readTools 依赖 store/paths，本文件其它用例不需要它
  const { READ_ONLY_TOOL_DEFINITIONS } = await import('../src/workspace/toolDefs/readTools.js');
  const readTool = READ_ONLY_TOOL_DEFINITIONS.find(item => item.name === 'read_workspace_file');
  const store = {
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      return { content: files[path], total: files[path].length, offset: 0, truncated: false };
    },
  };
  assert.equal(
    String(await readTool.execute({ store }, { path: `${SKILLS_DIR}/weekly-report/scripts/gen.py` }, {})),
    'print("gen")',
    'scripts 资源可读'
  );
  assert.equal(
    String(await readTool.execute({ store }, { path: `${SKILLS_DIR}/weekly-report/templates/report.md` }, {})),
    '# 模板',
    'templates 资源可读'
  );
});

test('pickSkillFiles：只挑 <dir>/<name>/SKILL.md（大小写宽容），跳过目录与其它文件', () => {
  const picked = pickSkillFiles([
    `${SKILLS_DIR}/alpha/${SKILL_FILE_NAME}`,
    `${SKILLS_DIR}/beta/skill.md`,
    `${SKILLS_DIR}/gamma/notes.md`,
    `${SKILLS_DIR}/delta/`,
    `${SKILLS_DIR}/epsilon/${SKILL_FILE_NAME}/nested.txt`,
    'notes/readme.md',
  ]);
  assert.deepEqual(picked.map(item => item.dirName), ['alpha', 'beta']);
  assert.equal(picked[1].path.endsWith('skill.md'), true, '返回原始路径（读取时大小写要对得上）');
});

test('readWorkspaceSkills：正常解析；目录不存在为空；单个坏文件只跳过它', async () => {
  const files = {
    [`${SKILLS_DIR}/weekly-report/${SKILL_FILE_NAME}`]: '---\nname: 周报\ndescription: 整理周报\n---\n正文',
    [`${SKILLS_DIR}/plain/${SKILL_FILE_NAME}`]: '# 标题\n第一段说明',
    [`${SKILLS_DIR}/broken/${SKILL_FILE_NAME}`]: 'x',
  };
  const store = makeStore(files);
  // 让 broken 的读取抛错（模拟编码坏/读失败）
  const originalRead = store.readWorkspaceFile;
  store.readWorkspaceFile = async options => {
    if (options.path.includes('/broken/')) throw new Error('decode failed');
    return originalRead(options);
  };
  const skills = await readWorkspaceSkills(store, 'c1');
  const names = skills.map(item => item.name).sort();
  assert.deepEqual(names, ['plain', '周报'].sort());
  assert.equal(skills.every(item => item.path.startsWith(`${SKILLS_DIR}/`)), true);

  assert.deepEqual(await readWorkspaceSkills(makeStore({}), 'c1'), [], '技能目录不存在 → 空');
  assert.deepEqual(await readWorkspaceSkills(null, 'c1'), [], '没有 store → 空，不抛错');
});

test('installSampleSkills：写入 3 个示例、幂等、绝不覆盖已有技能', async () => {
  const files = {};
  const store = makeStore(files);
  assert.equal(await installSampleSkills(store, 'c1'), SAMPLE_SKILLS.length);
  assert.equal(Object.keys(files).length, SAMPLE_SKILLS.length);
  const path0 = `${SKILLS_DIR}/${SAMPLE_SKILLS[0].name}/${SKILL_FILE_NAME}`;
  assert.ok(files[path0].includes('---'), '示例带 frontmatter');

  // 用户改过其中的内容：再次安装不得覆盖，未装过的也已被装（返回 0）
  files[path0] = '用户自己改过的内容';
  assert.equal(await installSampleSkills(store, 'c1'), 0);
  assert.equal(files[path0], '用户自己改过的内容');
});

test('SAMPLE_SKILLS：3 个、名字唯一、每个都能被自己的解析器读出 name 与 description', () => {
  assert.equal(SAMPLE_SKILLS.length, 3);
  const names = new Set(SAMPLE_SKILLS.map(item => item.name));
  assert.equal(names.size, 3, '不能重名（目录会撞）');
  for (const sample of SAMPLE_SKILLS) {
    const parsed = parseSkillMarkdown(sample.markdown, sample.name);
    assert.ok(parsed.name, `${sample.name} 应能解析出名字`);
    assert.ok(parsed.description, `${sample.name} 应能解析出描述`);
    assert.ok(/^[a-z0-9-]+$/.test(sample.name), `${sample.name} 应是 slug 形态（目录名）`);
  }
});

test('提示词集成：read/write 注入技能清单；ask 不注入（没有读工具，说了也读不到）', () => {
  const skills = [{ name: 'weekly-report', description: '周报整理' }];
  const read = buildWorkspaceAgentSystemPrompt({ mode: 'read', skills });
  assert.ok(read.includes('工作区技能') && read.includes('weekly-report'));
  const write = buildWorkspaceAgentSystemPrompt({ mode: 'write', skills });
  assert.ok(write.includes('工作区技能'));
  const ask = buildWorkspaceAgentSystemPrompt({ mode: 'ask', skills });
  assert.equal(ask.includes('工作区技能'), false, 'ask 模式无 read 工具：注入清单等于教模型说谎');
  // 无技能时与旧行为一致
  const none = buildWorkspaceAgentSystemPrompt({ mode: 'read' });
  assert.equal(none.includes('工作区技能'), false);
});

test('接线契约：ChatPanel 每轮直读技能并传入；设置面板可安装示例；i18n 中英齐', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('readWorkspaceSkills(storeRef.current, ownerId)'), '发消息时直读技能清单');
  assert.ok(panel.includes('installSampleSkills(storeRef.current, characterId)'), '安装示例接线');
  assert.ok(/skills,\n\s*\}\);/.test(panel) || panel.includes('skills,'), 'skills 传进提示组装');

  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceSettingsSheet.js'), 'utf8');
  assert.ok(sheet.includes("id: 'skills'"), '设置面板有技能行');
  assert.ok(sheet.includes('onInstallSampleSkills'), '安装示例按钮接线');

  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  for (const key of ["'workspace.settings.skills'", "'workspace.settings.skills.hint'", "'workspace.settings.skills.install'"]) {
    assert.ok(zh.includes(key), `中文缺 ${key}`);
    assert.ok(en.includes(key), `英文缺 ${key}`);
  }
});

test('skill 工具：按名字取技能全文（也认目录名）；缺名/找不到报错', async () => {
  const { SKILL_TOOL_DEFINITION } = await import('../src/workspace/toolDefs/skillTool.js');
  const store = makeStore({
    [`.easychat/skills/weekly-report/${SKILL_FILE_NAME}`]: '---\nname: 周报\n---\n\n步骤一\n步骤二',
  });
  const ok = await SKILL_TOOL_DEFINITION.execute({ store }, { name: '周报' }, {});
  assert.ok(ok.content.includes('步骤一') && ok.content.includes('步骤二'), '返回全文');
  const byDir = await SKILL_TOOL_DEFINITION.execute({ store }, { name: 'weekly-report' }, {});
  assert.ok(byDir.content.includes('步骤一'), '也认目录名');
  const missing = await SKILL_TOOL_DEFINITION.execute({ store }, { name: '不存在' }, {});
  assert.equal(missing.isError, true);
  const empty = await SKILL_TOOL_DEFINITION.execute({ store }, {}, {});
  assert.equal(empty.isError, true);
});
