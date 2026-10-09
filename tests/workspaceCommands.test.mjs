// 工作区斜杠命令测试（spec: 2026-10-09-agent-extensibility T5）。
//
// 覆盖：① 解析（frontmatter description / 模板保留原样）；② 目录挑选；
// ③ 模板渲染（$ARGUMENTS 多处替换 / 无占位符追加 / 空参数）；④ 展开四态
// （命中 / 未命中 / 非命令形态 / 大小写）；⑤ 建议查询与过滤；⑥ 示例安装幂等
// 不覆盖；⑦ 接线契约与 i18n。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMMANDS_DIR,
  SAMPLE_COMMANDS,
  expandSlashCommand,
  installSampleCommands,
  matchSlashCommands,
  parseCommandMarkdown,
  pickCommandFiles,
  readWorkspaceCommands,
  renderCommandTemplate,
  slashQuery,
} from '../src/workspace/commands.js';

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

test('parseCommandMarkdown：描述取 frontmatter、模板保留正文原样、无 frontmatter 退化', () => {
  const full = parseCommandMarkdown([
    '---',
    'description: 把素材整理成周报',
    '---',
    '按流程整理：',
    '',
    '$ARGUMENTS',
  ].join('\n'), 'weekly');
  assert.equal(full.name, 'weekly');
  assert.equal(full.description, '把素材整理成周报');
  assert.ok(full.template.startsWith('按流程整理：'));
  assert.ok(full.template.includes('$ARGUMENTS'));

  const plain = parseCommandMarkdown('直接一段模板', 'raw');
  assert.equal(plain.name, 'raw');
  assert.equal(plain.description, '');
  assert.equal(plain.template, '直接一段模板');
});

test('pickCommandFiles：只挑 <dir>/<name>.md（不递归子目录、忽略非 md）', () => {
  const picked = pickCommandFiles([
    `${COMMANDS_DIR}/weekly.md`,
    `${COMMANDS_DIR}/polish.MD`,
    `${COMMANDS_DIR}/notes.txt`,
    `${COMMANDS_DIR}/sub/nested.md`,
    `${COMMANDS_DIR}/folder/`,
  ]);
  assert.deepEqual(picked.map(item => item.name), ['weekly', 'polish']);
});

test('renderCommandTemplate：$ARGUMENTS 全替换；无占位符时参数追加到末尾（不丢输入）', () => {
  assert.equal(renderCommandTemplate('做：$ARGUMENTS', 'A B'), '做：A B');
  assert.equal(renderCommandTemplate('$ARGUMENTS 和 $ARGUMENTS', 'X'), 'X 和 X', '多处占位符都替换');
  assert.equal(renderCommandTemplate('做：$ARGUMENTS', ''), '做：', '空参数 → 占位符替换为空');
  assert.equal(renderCommandTemplate('固定模板', '我的素材'), '固定模板\n\n我的素材');
  assert.equal(renderCommandTemplate('固定模板', ''), '固定模板');
});

test('expandSlashCommand：命中展开；未命中/非命令形态/路径样文本一律 null（原样发送）', () => {
  const commands = [
    { name: 'weekly', template: '整理：$ARGUMENTS' },
    { name: 'Polish', template: '润色：$ARGUMENTS' },
  ];
  const hit = expandSlashCommand('/weekly 这周的进展', commands);
  assert.equal(hit.name, 'weekly');
  assert.equal(hit.args, '这周的进展');
  assert.equal(hit.text, '整理：这周的进展');

  assert.equal(expandSlashCommand('/weekly', commands).args, '', '不带参数也行');
  assert.equal(expandSlashCommand('/POLISH 文字', commands).name, 'Polish', '大小写不敏感');
  assert.equal(expandSlashCommand('/nope 参数', commands), null, '未知命令不展开');
  assert.equal(expandSlashCommand('/a/b', commands), null, '以 / 开头的路径不当命令');
  assert.equal(expandSlashCommand('普通文本 /weekly', commands), null, '不是以 / 开头就不算命令');
  assert.equal(expandSlashCommand('/weekly', []), null, '没有命令表时不展开');
});

test('slashQuery / matchSlashCommands：只在打命令名时给建议，前缀过滤大小写不敏感', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/we'), 'we');
  assert.equal(slashQuery('/weekly 已经写出参数了'), null, '开始写参数就收起建议');
  assert.equal(slashQuery('普通文本'), null);
  assert.equal(slashQuery('  /先有空白'), null);

  const commands = [{ name: 'weekly' }, { name: 'polish' }, { name: 'explain' }];
  assert.deepEqual(matchSlashCommands(commands, '').map(item => item.name), ['weekly', 'polish', 'explain']);
  assert.deepEqual(matchSlashCommands(commands, 'w').map(item => item.name), ['weekly']);
  assert.deepEqual(matchSlashCommands(commands, 'POL').map(item => item.name), ['polish']);
  assert.deepEqual(matchSlashCommands(commands, 'zz'), []);
  assert.deepEqual(matchSlashCommands(null, ''), [], '没有命令表 → 空，不抛错');
});

test('readWorkspaceCommands：正常解析；目录不存在为空；坏文件只跳过它', async () => {
  const files = {
    [`${COMMANDS_DIR}/weekly.md`]: '---\ndescription: 周报\n---\n整理：$ARGUMENTS',
    [`${COMMANDS_DIR}/broken.md`]: 'x',
  };
  const store = makeStore(files);
  const originalRead = store.readWorkspaceFile;
  store.readWorkspaceFile = async options => {
    if (options.path.includes('/broken.md')) throw new Error('decode failed');
    return originalRead(options);
  };
  const commands = await readWorkspaceCommands(store, 'c1');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'weekly');
  assert.equal(commands[0].description, '周报');
  assert.ok(commands[0].template.includes('$ARGUMENTS'), '模板必须是全文（展开要用完整模板）');

  assert.deepEqual(await readWorkspaceCommands(makeStore({}), 'c1'), [], '命令目录不存在 → 空');
  assert.deepEqual(await readWorkspaceCommands(null, 'c1'), []);
});

test('installSampleCommands：写入 3 个示例、幂等、绝不覆盖已有命令', async () => {
  const files = {};
  const store = makeStore(files);
  assert.equal(await installSampleCommands(store, 'c1'), SAMPLE_COMMANDS.length);
  const path0 = `${COMMANDS_DIR}/${SAMPLE_COMMANDS[0].name}.md`;
  files[path0] = '我改过的模板';
  assert.equal(await installSampleCommands(store, 'c1'), 0);
  assert.equal(files[path0], '我改过的模板', '用户改过的命令文件不得被覆盖');
});

test('SAMPLE_COMMANDS：4 个（含 A6 的 /remember）、名字唯一且是 slug、每个都能展开出非空文本', () => {
  assert.equal(SAMPLE_COMMANDS.length, 4);
  assert.equal(new Set(SAMPLE_COMMANDS.map(item => item.name)).size, 4);
  // A6：/remember 是「跨会话经验沉淀」的零新代码通路（组合 T5 命令 + T2 记忆文件）
  const remember = SAMPLE_COMMANDS.find(item => item.name === 'remember');
  assert.ok(remember, '/remember 必须在示例里');
  assert.match(
    parseCommandMarkdown(remember.markdown, 'remember').template,
    /AGENTS\.md/,
    '它要把约定写进 AGENTS.md'
  );
  for (const sample of SAMPLE_COMMANDS) {
    assert.ok(/^[a-z0-9-]+$/.test(sample.name), `${sample.name} 应是 slug（文件名）`);
    const parsed = parseCommandMarkdown(sample.markdown, sample.name);
    assert.ok(parsed.description, `${sample.name} 应有描述（建议列表要显示）`);
    const expanded = expandSlashCommand(`/${sample.name} 素材`, [parsed]);
    assert.ok(expanded && expanded.text.includes('素材'), `${sample.name} 展开应带上参数`);
  }
});

test('接线契约：ChatPanel 建议条 + 发送时展开；设置面板命令行；i18n 中英齐', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('slashQuery(input)'), '建议条按输入过滤');
  assert.ok(panel.includes('expandSlashCommand(userText, freshCommands)'), '发送时按最新命令表展开');
  assert.ok(panel.includes('userText: outgoingText'), '请求用展开文本、气泡用原文');
  assert.ok(panel.includes('installSampleCommands(storeRef.current, characterId)'), '安装示例接线');

  const sheet = fs.readFileSync(path.resolve('src/workspace/WorkspaceSettingsSheet.js'), 'utf8');
  assert.ok(sheet.includes("id: 'commands'"), '设置面板有命令行');

  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  for (const key of ["'workspace.settings.commands'", "'workspace.settings.commands.hint'", "'workspace.settings.commands.install'"]) {
    assert.ok(zh.includes(key), `中文缺 ${key}`);
    assert.ok(en.includes(key), `英文缺 ${key}`);
  }
});
