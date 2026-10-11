// 触控目标 / 弹窗宽度上限 / 长路径截断的回归护栏。
//
// 同样用**源码结构断言**（只钉已修复的回归，不用于新功能）：这三类问题都不会让界面
// 报错或崩——按钮小一圈、宽屏表单拉满、长路径尾截断，肉眼在手机上根本看不出来，
// 只能机检。
//
// 依据：设计令牌 src/theme/tokens.js 的 metrics.buttonHeight = 44（iOS HIG / Material
// 的最小触控目标）；手写图标按钮普遍只有 32~36pt，靠 hitSlop 补到 44pt 等效。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('设计令牌：buttonHeight 仍是 44（触控目标口径的唯一来源）', () => {
  // tokens.js 带 Flow 注解、Node 载不进来（与主题表不同），只能读源码钉这个数字。
  assert.match(read('src/theme/tokens.js'), /buttonHeight:\s*44\b/, 'buttonHeight 变了，触控目标口径随之失效');
});

test('弹窗卡片有宽度上限：宽屏/横屏不再拉满整屏', () => {
  const dir = path.resolve('src/chat');
  const modals = fs.readdirSync(dir).filter(name => name.endsWith('Modal.js'));
  assert.equal(modals.length, 16);
  const styles = read('src/chat/chatStyles.js');
  // 共享样式键本身的口径
  assert.ok(
    styles.includes("sheetWidth: { maxWidth: 520, alignSelf: 'center', width: '100%' }"),
    'sheetWidth 口径变了：应为 maxWidth 520 + 居中 + 手机上仍是 100%'
  );
  // 全屏输入弹窗的容器样式定义在 chatStyles 里（本身就是单行样式，直接内联了上限）
  assert.ok(
    /fullScreenContainer: \{[^}]*maxWidth: 520/.test(styles),
    'fullScreenContainer 缺宽度上限'
  );
  for (const name of modals) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const capped = source.includes('styles.sheetWidth')
      || source.includes('maxWidth: 520')
      || (source.includes('styles.fullScreenContainer') && /fullScreenContainer: \{[^}]*maxWidth: 520/.test(styles));
    assert.ok(capped, `${name}: 卡片没有宽度上限（宽屏/横屏会拉满整屏）`);
  }
});

test('小图标按钮靠 hitSlop 补到 44pt 等效（尺寸不变，视觉不变）', () => {
  const cases = [
    // 32×32 的删除键：+8×2 = 48
    ['src/chat/BranchForkRow.js', 'styles.branchDeleteButton', 'hitSlop={8}'],
    // 高度仅 ~23 的消息操作键：上下 +11 → 45
    ['src/chat/MessageBubble.js', 'styles.messageActionButton', 'hitSlop={{ top: 11, bottom: 11, left: 6, right: 6 }}'],
    // 34×34 的终端运行键：+8×2 = 50
    ['src/workspace/screen/TerminalPanel.js', 'styles.sendButton', 'hitSlop={8}'],
    // 14pt 图标的移除附件键：+15×2 = 44
    ['src/chat/ChatComposer.js', 'onRemoveAttachment(item.id)', 'hitSlop={15}'],
    // 36×36 的工作区对话发送/停止/补充指令键：+8×2 = 52
    ['src/workspace/screen/ChatPanel.js', "t('workspace.chat.send.a11y')", 'hitSlop={8}'],
    ['src/workspace/screen/ChatPanel.js', "t('workspace.chat.stop.a11y')", 'hitSlop={8}'],
    ['src/workspace/screen/ChatPanel.js', "t('workspace.chat.steer.a11y')", 'hitSlop={8}'],
  ];
  for (const [file, marker, need] of cases) {
    const source = read(file);
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${file}: 找不到 ${marker}`);
    // hitSlop 必须出现在同一开标签内。这里不用 indexOf('>') 找标签结尾——
    // 属性里的箭头函数（onPress={() => ...}）自带 '>'，会把切片截断在中间。
    // 取 marker 前后各一段固定窗口即可覆盖整个开标签。
    const window = source.slice(Math.max(0, at - 400), at + 400);
    assert.ok(window.includes(need), `${file}: ${marker} 所在的可点元素缺 ${need}`);
  }
});

test('工作区两栏分隔条：容器加宽到 28 且对读屏可调', () => {
  const source = read('src/workspace/screen/WorkspaceScreen.js');
  assert.ok(
    source.includes("splitter: { width: 28, alignItems: 'center', justifyContent: 'center' }"),
    '分隔条容器应从 14 加宽到 28（视觉仍是 3px 细线，只是手指够得着）'
  );
  assert.ok(source.includes('accessibilityRole="adjustable"'), '分隔条缺 adjustable 角色');
  assert.ok(source.includes("t('workspace.home.splitterA11y')"), '分隔条缺可读 label');
  assert.ok(source.includes('accessibilityActions={['), '分隔条缺 adjust 手势（读屏用户无法改宽度）');
  assert.ok(source.includes('onAccessibilityAction='), '分隔条缺 adjust 手势处理');
});

test('路径与分支名统一 ellipsizeMode="middle"（长路径不丢尾部区分度）', () => {
  const cases = [
    ['src/workspace/screen/FilesPanel.js', 'styles.searchDir'],
    ['src/workspace/screen/FilesPanel.js', 'styles.projectName'],
    ['src/workspace/screen/FilesPanel.js', 'styles.fileName'],
    ['src/workspace/screen/GithubPanel.js', 'styles.repoName'],
    ['src/workspace/screen/GithubPanel.js', 'styles.layerTitle'],
    ['src/workspace/screen/TurnSummaryPanel.js', 'styles.path'],
    ['src/workspace/screen/GitHistoryPanel.js', 'styles.filePath'],
    ['src/workspace/screen/TerminalPanel.js', 'styles.cwd'],
  ];
  for (const [file, styleRef] of cases) {
    const source = read(file);
    const at = source.indexOf(styleRef);
    assert.notEqual(at, -1, `${file}: 找不到 ${styleRef}`);
    const tagEnd = source.indexOf('>', at);
    assert.ok(
      source.slice(at, tagEnd).includes('ellipsizeMode="middle"'),
      `${file}: ${styleRef} 的长文本缺 ellipsizeMode="middle"（Android 会尾截断）`
    );
  }
});
