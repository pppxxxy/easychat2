// 守卫：`plugins/*/android/` 下的源码必须真的被 git 跟踪。
//
// 为什么需要这条测试（真实踩过两次的坑）：
// `.gitignore` 第 8 行的 `android/` 规则会**连目录本身一起排除**，于是 git 不再
// 往目录里面看——只写 `!plugins/<name>/android/**` 那一行是无效的，必须是
// 「先免目录、再免内容」两行成对。新插件忘了补豁免时的表现极具欺骗性：
//
// - 本地 `npm test` **全绿**（源码就在工作区里，只是没被 add）；
// - 干净检出 / CI 缺文件：`readKotlinFiles` 抛 `ENOENT: scandir`；
// - `npm run prebuild` 时插件的 `fs.readdirSync(srcDir)` 当场抛错，**APK 打不了**。
//
// 第一次是 localApiServer（AGENTS.md 有记载），第二次是 shellExecutor：
// 2026-10-03 monkey 在干净检出里发现我自报的 1118/1118 实际是 1114/1118。
// 与其指望下一个新增插件的人记住这条规则，不如让测试直接去问 git。
//
// 依赖面：需要 git 与真实工作树。打包分发（无 .git）时跳过，不让它成为环境噪声。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

function runGit(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function gitWorkspaceAvailable() {
  if (!existsSync(path.join(ROOT, '.git'))) return false;
  try {
    return runGit(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch (error) {
    return false;
  }
}

// 插件目录下保存的源码（.kt/.java/.js 等）：都是要入库的东西。
function pluginSourceFiles() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const files = [];
  for (const name of readdirSync(PLUGINS_DIR).sort()) {
    const androidDir = path.join(PLUGINS_DIR, name, 'android');
    if (!existsSync(androidDir) || !statSync(androidDir).isDirectory()) continue;
    for (const file of readdirSync(androidDir).sort()) {
      if (file.endsWith('.kt') || file.endsWith('.java')) {
        files.push(path.posix.join('plugins', name, 'android', file));
      }
    }
  }
  return files;
}

const GIT = gitWorkspaceAvailable();

test('plugins/*/android 下的 Kotlin 源码都被 git 跟踪（.gitignore 豁免成对）', { skip: !GIT && '无 git 工作树，跳过' }, () => {
  const files = pluginSourceFiles();
  // 至少要有文件才谈得上守卫：全空说明插件目录都读不到了，是另一种故障
  assert.ok(files.length > 0, '没有发现任何插件 Kotlin 源码，插件目录结构可能已变');

  const untracked = [];
  for (const file of files) {
    try {
      runGit(['ls-files', '--error-unmatch', file]);
    } catch (error) {
      untracked.push(file);
    }
  }
  assert.deepEqual(
    untracked,
    [],
    `以下插件源码在工作区里存在但**没有被 git 跟踪**：\n  ${untracked.join('\n  ')}\n`
      + '原因通常是 .gitignore 的 `android/` 规则吞了目录，而该插件缺豁免。'
      + '修法：在 .gitignore 里**成对**补上 `!plugins/<name>/android/` 与 `!plugins/<name>/android/**`，'
      + '再 `git add plugins/<name>/android/`（只写 `**` 那行是无效的：目录被排除后 git 不再往里看）。',
  );
});

test('每个 android 目录都同时有「免目录」与「免内容」两条豁免', { skip: !GIT && '无 git 工作树，跳过' }, async () => {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(line => line.trim());
  const names = new Set(
    pluginSourceFiles().map(file => file.split('/')[1])
  );
  assert.ok(names.size > 0, '没有发现任何插件 android 目录');
  const missing = [];
  for (const name of names) {
    const dirRule = `!plugins/${name}/android/`;
    const contentRule = `!plugins/${name}/android/**`;
    if (!lines.includes(dirRule)) missing.push(dirRule);
    if (!lines.includes(contentRule)) missing.push(contentRule);
  }
  assert.deepEqual(missing, [], `缺少豁免行（缺「免目录」那行时整条豁免都是失效的）：\n  ${missing.join('\n  ')}`);
});
