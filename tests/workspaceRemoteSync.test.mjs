// 工作区 agent「对齐远端」能力的两块修复（2026-10-18）。
//
// 用户实测（截图）：让工作区助手「拉取 easychat2 远端仓库」，助手**确实拉下来了**
// （列出了 package.json / app.json / babel.config.js / README.md / CHANGELOG.md），
// 但接着回答「本副本没有 remote 配置、环境没有 git 二进制、materialize 失败，
// 三者至少解决两个才能拉取」。
//
// 三点全对，**结论错了**：它已经拉到了。根因有两个，这个文件各钉一组：
//
//   A. 快照没记基线提交号 → 拉完之后永远答不出「与远端差多少」。
//      修复 = 拉取时取分支 HEAD sha 写进 pull-manifest。
//   B. 提示词从没讲过 repos/ 是什么 → 模型拿 run_shell + git 的心智模型去套 zip 快照。
//      修复 = 注入 repos/ 快照语义，并在 GitHub 工具**真的注册了**时指向它们。
//
// ⚠️ 这个文件刻意不测「模型会不会照着做」——那要靠真机。它测的是**我们给它的信息
// 与工具是否自洽**：基线记录得住、提示词不说假话、且不点名没注册的工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parsePullManifest, writePullManifest, PULL_MANIFEST_PATH } from '../src/workspace/repoImport.js';
import { buildWorkspaceAgentSystemPrompt, repoSnapshotHint, REPO_SNAPSHOT_HINT } from '../src/workspace/chat.js';
import { translate } from '../src/i18n/index.js';

const VALID_SHA = 'f'.repeat(40);

// ---- A. 基线提交号能存能取 ----

test('pull-manifest 能记住基线提交号，并对非法值保持沉默', async () => {
  const files = {};
  const store = {
    async writeWorkspaceFile({ path: file, content }) { files[file] = content; },
  };

  // 正常写入 → 读回来一模一样（含 sha）
  assert.equal(
    await writePullManifest(store, 'c1', {
      owner: 'o', repo: 'r', branch: 'main', files: 12, sha: VALID_SHA,
    }),
    true
  );
  const written = JSON.parse(files[PULL_MANIFEST_PATH]);
  assert.equal(written.sha, VALID_SHA, 'sha 必须真的落盘（否则「差多少」永远算不出）');
  assert.equal(written.files, 12);

  const parsed = parsePullManifest(files[PULL_MANIFEST_PATH]);
  assert.equal(parsed.sha, VALID_SHA, '读回来必须还是同一个 sha');
});

test('拿不到 sha 时不写该字段（不伪造一个不存在的基线）', async () => {
  const files = {};
  const store = {
    async writeWorkspaceFile({ path: file, content }) { files[file] = content; },
  };

  for (const badSha of ['', null, undefined, 'not-a-sha', 'deadbeef', 'g'.repeat(40)]) {
    await writePullManifest(store, 'c1', {
      owner: 'o', repo: 'r', branch: 'main', files: 1, sha: badSha,
    });
    const written = JSON.parse(files[PULL_MANIFEST_PATH]);
    assert.equal(
      'sha' in written,
      false,
      `非法 sha（${JSON.stringify(badSha)}）不应落盘——宁可没有，也不要一个假基线`
    );
    // 读侧同样回落为空串（= 不知道基线），而不是 null（null 要留给「解析失败」）
    assert.equal(parsePullManifest(files[PULL_MANIFEST_PATH]).sha, '');
  }
});

test('旧 manifest（没有 sha 字段）仍可用：sha 回落空串而非解析失败', () => {
  const legacy = JSON.stringify({ owner: 'o', repo: 'r', branch: 'main', files: 3, at: 123 });
  const parsed = parsePullManifest(legacy);
  assert.notEqual(parsed, null, '旧数据不能变成「读不出来」');
  assert.equal(parsed.files, 3);
  assert.equal(parsed.sha, '', '旧数据 = 不知道基线，用空串表达');
});

test('sha 归一为小写（GitHub 有时回大写，比对时不该因大小写不同而误判）', () => {
  const upper = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const parsed = parsePullManifest({
    owner: 'o', repo: 'r', branch: 'main', files: 1, sha: upper,
  });
  assert.equal(parsed.sha, upper.toLowerCase());
});

// ---- B. 提示词：讲清 repos/ 是什么 ----

test('repos/ 语义常驻：说了「不含 .git 历史」与「git fetch 走不通」', () => {
  const prompt = buildWorkspaceAgentSystemPrompt({ mode: 'read', tools: ['read_workspace_file'] });
  assert.match(prompt, /repos\//, '必须点明 repos/ 这个目录');
  assert.match(prompt, /快照/, '必须说明它是快照（不是克隆）');
  assert.match(prompt, /不含 \.git 历史|不含 git 历史/, '必须说明没有 git 历史');
  assert.match(prompt, /没有 git 二进制/, '必须说明 git 二进制不存在（这正是助手当时说的第 2 点）');
});

test('ask 模式不注入 repos/ 说明（读不到文件，讲了是噪音）', () => {
  const prompt = buildWorkspaceAgentSystemPrompt({ mode: 'ask' });
  assert.equal(/repos\/ 下是/.test(prompt), false, 'ask 模式没有文件工具，不该讲 repos/');
});

test('GitHub 只读工具：注册了才点名，没注册一个字都不提', () => {
  // 没注册 → 基础段里不能出现 github_ 工具名（本仓库铁律：不承诺调不动的能力）
  const withoutGithub = buildWorkspaceAgentSystemPrompt({
    mode: 'read',
    tools: ['read_workspace_file', 'list_workspace_files'],
  });
  assert.equal(/github_/.test(withoutGithub), false, '没注册 GitHub 工具时不得点名 github_*');
  assert.match(withoutGithub, /repos\//, '但 repos/ 的语义说明仍然要在（它不依赖任何工具）');

  // 注册了 → 必须点名，并说清「用哪个工具查远端」
  const withGithub = buildWorkspaceAgentSystemPrompt({
    mode: 'read',
    tools: ['read_workspace_file', 'github_list_commits', 'github_get_file_contents'],
  });
  assert.match(withGithub, /github_list_commits/, '注册了就告诉模型用哪个工具看远端提交');
  assert.match(withGithub, /github_get_file_contents/, '也告诉它怎么直接取远端文件');
  assert.match(withGithub, /pull-manifest\.json/, '要点明基线提交号记在哪');
});

test('GitHub 提示按前缀判定，不写死某一个工具名', () => {
  // 只要注册表里有任意 github_ 工具就追加（服务端工具集可能演进，不该写死清单）
  assert.match(repoSnapshotHint(['github_list_branches']), /github_list_commits/);
  assert.match(repoSnapshotHint(['github_search_code']), /pull-manifest/);
  // 非 github_ 前缀不算
  assert.equal(/github_/.test(repoSnapshotHint(['read_workspace_file', 'x__y'])), false);
  assert.equal(/github_/.test(repoSnapshotHint([])), false);
  assert.equal(/github_/.test(repoSnapshotHint(null)), false);
});

test('常驻段本身不含任何工具名（否定句点名也算点名）', () => {
  // 这条来自一次真实翻车：初版写「不要用 run_shell 或 git 命令…」，于是
  // 「没注册 run_shell」的会话里提示词仍然出现 run_shell，被 workspaceChat 的守卫拦下。
  const base = REPO_SNAPSHOT_HINT;
  for (const toolName of ['run_shell', 'run_python', 'github_', 'materialize_repo']) {
    assert.equal(
      base.includes(toolName),
      false,
      `常驻段不得出现工具名「${toolName}」——它会承诺一个本会话可能不存在的工具`
    );
  }
});

// ---- 能力说明（用户可见文案）与实现一致 ----

test('能力说明文案：双语都提到「拉取时记录分支 HEAD 提交号」', () => {
  for (const locale of ['zh-CN', 'en']) {
    const text = translate(locale, 'workspace.capability.limit.githubImport');
    assert.ok(text.includes('HEAD'), `${locale} 的能力说明应提到 HEAD 提交号`);
    assert.ok(text.includes('pull-manifest.json'), `${locale} 的能力说明应给出清单路径`);
    // 「不含 git 历史」这条仍然要保留——它是真实边界，别在补充信息时丢掉
    assert.match(text, /不含 git 历史|no git history/);
  }
});

// ---- 接线契约：拉取真的会去取 sha ----

test('接线：拉取流程会取分支 HEAD sha 并写进清单', () => {
  const source = fs.readFileSync(
    path.resolve('src/workspace/screen/github/useRepoPull.js'),
    'utf8'
  );
  assert.match(source, /listCommits\(/, '拉取时必须调用 listCommits 取基线提交号');
  assert.match(source, /sha:\s*headSha/, '必须把取到的 sha 传给 writePullManifest');
  // 取 sha 失败不得让拉取失败——文件已经拿到了，缺个基线不该回滚
  assert.match(source, /catch[\s\S]{0,200}headSha = ''/, '取 sha 失败要静默降级为空');
  // 顺序：manifest 先写（含 sha），再逐个写文件——中途中断不会留「已写入却缺 sha」的半成品
  const manifestIndex = source.indexOf('writePullManifest(store, characterId, {');
  const writeLoopIndex = source.indexOf('for (let index = 0; index < files.length');
  assert.ok(manifestIndex > 0 && writeLoopIndex > 0, '两处代码都应存在');
  assert.ok(manifestIndex < writeLoopIndex, 'manifest（含 sha）必须先于文件写入循环');
});
