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
