import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CI 供应链加固：workflow 里的 actions/* 必须固定到 commit SHA，而不是可变的
// 大版本 tag（如 @v4），避免上游 tag 被移动时代码悄然变化。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', '.github', 'workflows');
const SHA_PATTERN = /^[0-9a-f]{40}$/;

test('workflows 的 actions/* 固定到 commit SHA', () => {
  const files = readdirSync(WORKFLOW_DIR).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'));
  assert.ok(files.length > 0, '应存在 workflow 文件');

  let checked = 0;
  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const uses = source.match(/uses:\s*[^\s#]+/g) || [];
    for (const entry of uses) {
      const ref = entry.replace(/^uses:\s*/, '').trim();
      // 只约束 actions/*（第三方 action）；本地 composite 路径或 docker:// 不在此列。
      if (!ref.startsWith('actions/')) continue;
      const at = ref.lastIndexOf('@');
      assert.ok(at > 0, `${file}: ${ref} 缺少版本引用`);
      const sha = ref.slice(at + 1);
      assert.ok(
        SHA_PATTERN.test(sha),
        `${file}: ${ref} 应固定到 40 位 commit SHA，而不是可变 tag`
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, '应至少检查到一个 actions/* 引用');
});

test('workflows 不得引用 @latest（可变版本 = 供应链风险）', () => {
  // 回归 2026-10-11 逐行审查：eas-build-debug.yml 用的是 `npx eas-cli@latest`，而
  // build-apk.yml 钉的是 `eas-cli@24.8.0`。原守卫只查 `uses: actions/*` 的 SHA，
  // 完全没覆盖 `npx <pkg>@latest` 这种形态——于是「跑的是没审过的最新版」一直没人拦。
  const files = readdirSync(WORKFLOW_DIR).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'));
  const offenders = [];
  let pinned = 0;
  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (line.includes('@latest')) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
    // 顺带统计「已钉住版本」的 CLI 引用：一条都没统计到说明规则可能已空转（没有管束对象）。
    pinned += (source.match(/\b(?:npx|npm\s+(?:install|i)\s+-g)\s+[a-z0-9@/_-]+@\d+\.\d+\.\d+/g) || []).length;
  }
  assert.deepEqual(
    offenders,
    [],
    `以下位置使用了 @latest（可变引用），请钉到具体版本：\n${offenders.join('\n')}`
  );
  assert.ok(pinned > 0, `应至少检查到一个已钉住版本的 CLI 引用，实际 ${pinned} 个（规则可能空转）`);
});

test('GitHub Gradle APK 工作流动态写入 versionCode，避免覆盖安装失败', () => {
  // app.json 的 versionCode 是固定值：Gradle 路径每次打同一个 versionCode，
  // 覆盖安装会失败。工作流需在 prebuild 前按 run_number 写回一个单调递增的值。
  const gradleFlow = readFileSync(
    path.join(WORKFLOW_DIR, 'build-apk-github.yml'),
    'utf8'
  );
  assert.match(gradleFlow, /versionCode = 1000 \+ runNumber/);
  assert.ok(gradleFlow.includes('GITHUB_RUN_NUMBER: ${{ github.run_number }}'));
  // 必须在生成原生工程之前写回，否则 versionCode 不生效
  assert.ok(
    gradleFlow.indexOf('Stamp dynamic versionCode') < gradleFlow.indexOf('expo prebuild'),
    'versionCode 注入必须早于 prebuild'
  );
});
