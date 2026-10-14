// CI workflow 的**命名守卫**：workflow 名不得与它下面任何 job 名相同。
//
// 为什么需要这条（真实踩到）：
// GitHub 的 Actions 列表页与提交状态显示的是 **workflow 名**，而 job 名只在点进去后
// 才看得到。`.github/workflows/unit-tests.yml` 原本 workflow 名与其中一个 job 名**都是**
// `Unit tests`，于是 Kotlin 编译 job 失败时，页面显示「Unit tests failed」——
// 看起来像单元测试挂了，实际单元测试一直是绿的（run 279/280/283/284 都是这个假象）。
//
// 危害不是「显示得不好看」，而是**误导排查方向**：看到「Unit tests failed」的人会去翻
// 单元测试，而真正的问题在另一个 job。这与本仓把 Kotlin 错误接进 check-run annotations
// 是同一个动机——让 CI 的失败自己说清是哪个环节，而不是靠人去翻。
//
// 判据：workflow 的顶层 `name` 不得等于该文件里任一 job 的 `name`。
// 允许 workflow 名与 job 名**部分**重合（如 `Tests & Kotlin compile` 与 `Unit tests`
// 不相等即可），因为真正致幻的是**完全同名**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const WORKFLOW_DIR = path.resolve('.github/workflows');

function readWorkflows() {
  return fs.readdirSync(WORKFLOW_DIR)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map(name => {
      const file = path.join(WORKFLOW_DIR, name);
      return { name, source: fs.readFileSync(file, 'utf8') };
    });
}

test('CI：workflow 名不得与它下面任何 job 名相同（否则失败信息会指错环节）', () => {
  const offenders = [];
  for (const { name, source } of readWorkflows()) {
    let doc;
    try {
      doc = yaml.load(source);
    } catch (error) {
      assert.fail(`${name} 不是合法 YAML：${error.message}`);
    }
    const workflowName = String((doc && doc.name) || '').trim();
    if (!workflowName) continue;
    const jobNames = Object.values((doc && doc.jobs) || {})
      .map(job => String((job && job.name) || '').trim())
      .filter(Boolean);
    if (jobNames.includes(workflowName)) {
      offenders.push(`${name}: workflow 名「${workflowName}」与其中某个 job 同名`);
    }
  }
  assert.deepEqual(offenders, [],
    'workflow 名必须能概括它下面**所有** job；与某个 job 同名会让 GitHub 列表页'
    + '把那个 job 的失败显示成整个 workflow 的失败，误导排查方向：\n' + offenders.join('\n'));
});

test('CI：每个 job 都有显式 name（列表页/注解里可读，不靠 job id）', () => {
  const offenders = [];
  for (const { name, source } of readWorkflows()) {
    const doc = yaml.load(source);
    for (const [id, job] of Object.entries((doc && doc.jobs) || {})) {
      if (!job || !String(job.name || '').trim()) {
        offenders.push(`${name}: job「${id}」没有 name（会显示成 id）`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('CI：Kotlin 编译失败必须转成 check-run annotations（无 admin 也能读）', () => {
  // 这条守卫钉住「CI 红了但看不到为什么」的修复本身：
  // job 日志下载需要仓库 admin 权限（无权限时 403），而 check-run annotations
  // 接口无需 admin。所以 Kotlin 编译那一步**必须**把错误行转成 `::error::`，
  // 不能退回裸 `./gradlew ...`——退回去就等于把这个能力又丢了。
  //
  // ⚠️ 必须**剥掉注释**再判：这段逻辑的说明文字里就写着 `::error::` 与
  // `annotations`，按整文件匹配会在「代码已删、注释还在」时误判为通过
  //（我自己注入回归验证时就撞上了：去掉 echo 那一行，守卫仍然绿）。
  const source = fs.readFileSync(path.join(WORKFLOW_DIR, 'unit-tests.yml'), 'utf8');
  const code = source.split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(code.includes('::error::'), '必须把错误转成 ::error:: 工作流命令（不能只在注释里提）');
  assert.ok(code.includes('PIPESTATUS'),
    '必须用 PIPESTATUS 取 gradle 的真实退出码（tee 会吞掉它）');
  assert.ok(code.includes('exit "$status"'),
    '必须把真实退出码传出去，否则失败会被吞成成功');
  // 反向确认注释**确实**被剥掉了，否则上面第一条断言形同虚设
  assert.ok(source.includes('annotations'),
    '说明文字（为什么用 annotations）应在注释里保留，便于后人理解');
  assert.ok(!code.includes('annotations'),
    '剥注释后不应再有 annotations 字样——否则说明剥离逻辑失效');
});
