// guard-structure.mjs 的**行为**测试（门禁自身必须有测试）。
//
// 为什么必须有：这条守卫 2026-10-08 上线后一直是**空转**的——判据写成
// `/<Modal\s+visible=\{visible\}/`，只认 `visible={visible}` 这一种拼法，而真实违规
// （FilesPanel.js 的三处）写的是 `visible={characterPickerOpen}` / `{catalogOpen}` /
// `{!!preview}`，一条都不命中，脚本照样打印「ok：工作区面板未自套 Modal」。
//
// 纯源码断言（assert 脚本里含某句文案）**发现不了这种「规则写错」**：文案还在、函数还在，
// 规则却不再拦任何东西。唯一能钉住它的办法是把脚本真的跑起来、喂一个违规样本、
// 断言它**以非零码失败**。这就是本文件存在的理由。
//
// 做法：守卫用 `path.dirname(脚本)/..` 推导被扫描的 src 与 architecture-baseline.json，
// 所以把脚本原样复制进一个临时仓库根、在临时 src 里造违规文件，就能真实地执行它，
// 不需要给生产脚本开任何测试专用的后门开关。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD_SOURCE = path.resolve('scripts', 'guard-structure.mjs');

// 守卫在「面板自套 Modal」之前还有三道检查（根文件数 / storage.js 门面禁令 / 工作区单屏装配），
// 临时仓库必须先把它们喂饱，否则会在到达目标规则前就退出（那样测试会因为错误的原因变绿）。
function makeTempRepo({ panel = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-structure-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'workspace', 'screen'), { recursive: true });
  fs.copyFileSync(GUARD_SOURCE, path.join(root, 'scripts', 'guard-structure.mjs'));
  fs.writeFileSync(
    path.join(root, 'architecture-baseline.json'),
    JSON.stringify({ version: 1, maxFileLines: 800, excludedPaths: [], fileLineBaseline: {}, allowedCycles: [] })
  );
  // 门面禁令会扫 App.js；单屏装配会读 SettingsScreen.js——两者都必须存在。
  fs.writeFileSync(path.join(root, 'App.js'), '');
  fs.writeFileSync(
    path.join(root, 'src', 'SettingsScreen.js'),
    "import WorkspaceScreen from './workspace/screen/WorkspaceScreen.js';\n"
  );
  fs.writeFileSync(
    path.join(root, 'src', 'workspace', 'screen', 'WorkspaceScreen.js'),
    'export default function WorkspaceScreen() { return null; }\n'
  );
  if (panel !== null) {
    fs.writeFileSync(path.join(root, 'src', 'workspace', 'screen', 'FakePanel.js'), panel);
  }
  return root;
}

function withTempRepo(options, fn) {
  const root = makeTempRepo(options);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runGuard(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'guard-structure.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('守卫行为：面板自套 Modal（visible 绑的是状态变量）必须让门禁失败', () => {
  // 这三条正是 FilesPanel.js 历史上的真实写法——旧判据一条都不认，规则因此空转。
  const samples = [
    'export default function FakePanel() { return <Modal visible={characterPickerOpen} />; }\n',
    'export default function FakePanel() { return <Modal visible={catalogOpen} />; }\n',
    'export default function FakePanel() { return <Modal visible={!!preview} />; }\n',
  ];
  for (const panel of samples) {
    withTempRepo({ panel }, root => {
      const result = runGuard(root);
      assert.equal(result.status, 1, `守卫必须失败，却通过了：${panel.trim()}`);
      assert.match(result.stderr, /FakePanel\.js/, '失败信息要点名违规文件');
      assert.match(result.stderr, /自套 Modal/, '失败信息要说明违规原因');
    });
  }
});

test('守卫行为：面板自套 Modal（visible={visible} 旧拼法）仍然失败', () => {
  const panel = 'export default function FakePanel() { return <Modal visible={visible} />; }\n';
  withTempRepo({ panel }, root => {
    const result = runGuard(root);
    assert.equal(result.status, 1, '判据放宽后旧拼法也不能漏');
    assert.match(result.stderr, /FakePanel\.js/);
  });
});

test('守卫行为：面板不自套 Modal 时通过（对照组，防判据过宽误报）', () => {
  const panel = 'export default function FakePanel() { return <View style={{ flex: 1 }} />; }\n';
  withTempRepo({ panel }, root => {
    const result = runGuard(root);
    assert.equal(result.status, 0, `不该失败：\n${result.stderr}`);
    assert.match(result.stdout, /工作区面板未自套 Modal/);
  });
});

test('守卫行为：WorkspaceScreen 自己仍可持有唯一的那层 Modal', () => {
  withTempRepo({}, root => {
    fs.writeFileSync(
      path.join(root, 'src', 'workspace', 'screen', 'WorkspaceScreen.js'),
      'export default function WorkspaceScreen() { return <Modal visible={visible} />; }\n'
    );
    const result = runGuard(root);
    assert.equal(result.status, 0, `WorkspaceScreen 是唯一允许持有 Modal 的文件：\n${result.stderr}`);
  });
});

// 规则文字也是契约（2026-10-12 用户裁决）：行数基线**允许抬高**，前提是「提交说明写清理由 +
// 代码与结构仍满足长期可维护」。旧文案写的是「棘轮只许收紧」——而历史里抬高 113 次、
// 下调 104 次，文案与实际做法不符；规则和现实不符时，被绕过的一定是规则。
// 这条不测「文案存在」，测的是**被拦下的人看到的两条出口是否都在**：
// 只给「拆到子模块」等于继续骗人（有些增长是真的必要），只给「改数字」等于放水。
test('守卫行为：行数超基线时的失败信息必须给出两条真实出口（外提 / 有理由抬高）', () => {
  withTempRepo({}, root => {
    fs.mkdirSync(path.join(root, 'src', 'chat'), { recursive: true });
    const target = path.join(root, 'src', 'chat', 'Big.js');
    fs.writeFileSync(target, '// x\n'.repeat(900));
    fs.writeFileSync(
      path.join(root, 'architecture-baseline.json'),
      JSON.stringify({
        version: 1,
        maxFileLines: 800,
        excludedPaths: [],
        fileLineBaseline: { 'src/chat/Big.js': 900 },
        allowedCycles: [],
      })
    );
    // 基线 == 实际：这正是「有理由抬高后把基线改成新的实际值」的合法形态，必须通过
    const ok = runGuard(root);
    assert.equal(ok.status, 0, `基线 = 实际值应当通过：\n${ok.stderr}`);

    // 长一行 → 拦下，且失败信息要同时给出两条出口
    fs.appendFileSync(target, '// y\n');
    const blocked = runGuard(root);
    assert.equal(blocked.status, 1, '超出基线必须拦下');
    assert.match(blocked.stderr, /Big\.js：901 行 > 基线 900/, '要报出实际值与基线');
    assert.match(blocked.stderr, /拆到子模块/, '要给出「外提」这条出口');
    assert.match(blocked.stderr, /写清理由/, '要给出「有理由抬高」这条出口');
    assert.match(blocked.stderr, /长期可维护/, '抬高前必须确认代码与结构仍满足长期可维护');
    assert.match(blocked.stderr, /同一次提交/, '抬高必须与代码改动在同一次提交里完成');
    assert.doesNotMatch(blocked.stderr, /只许收紧/, '不得再写「只许收紧」这句与实际做法不符的话');
  });
});
