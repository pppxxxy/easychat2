// 无障碍回归护栏（聊天弹窗 / 折叠头 / 消息列表）。
//
// 这里用**源码结构断言**，按仓库约定只用于「钉已修复的回归」，不用于新功能：
//   - 16 个聊天 *Modal.js 此前 0/16 有 accessibilityViewIsModal → 读屏会继续读背后的
//     聊天内容，模态等于形同虚设；
//   - AgentPlanPanel / TurnSummaryPanel / ToolCallRow 的折叠头此前没有 role/label/
//     expanded 状态 → 读屏只念「chevron-up」，既不知道能点、也不知道当前是展开还是收起；
//   - MessageList 每条消息都挂 accessibilityRole="button" → 读屏把**每条消息**都念成
//     按钮，正文反而变成按钮标签。
// 三条都是「漏了就静默失效」的类型（界面看着完全正常），所以必须机检。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('16 个聊天弹窗的内层容器都声明了「模态」（iOS + Android 两套）', () => {
  const dir = path.resolve('src/chat');
  const modals = fs.readdirSync(dir).filter(name => name.endsWith('Modal.js'));
  assert.equal(modals.length, 16, `弹窗数量变了（期望 16，实际 ${modals.length}）：新增弹窗请一并补模态标记`);
  for (const name of modals) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(
      source.includes('accessibilityViewIsModal'),
      `${name}: 内层容器缺 iOS 的 accessibilityViewIsModal（读屏会继续读背后内容）`
    );
    assert.ok(
      source.includes('importantForAccessibility="yes"'),
      `${name}: 内层容器缺 Android 的 importantForAccessibility="yes"`
    );
  }
});

test('折叠头：role=button + accessibilityState.expanded + 明确 label', () => {
  const cases = [
    ['src/workspace/screen/AgentPlanPanel.js', "t('workspace.chat.plan.title'"],
    ['src/workspace/screen/TurnSummaryPanel.js', "t('workspace.chat.summary.title'"],
    ['src/workspace/screen/ToolCallRow.js', 'accessibilityLabel={tool.args'],
  ];
  for (const [file, labelNeedle] of cases) {
    const source = read(file);
    assert.ok(source.includes('accessibilityRole="button"'), `${file}: 折叠头缺 role=button`);
    assert.ok(source.includes('accessibilityState={{ expanded'), `${file}: 折叠头缺 expanded 状态`);
    assert.ok(source.includes(labelNeedle), `${file}: 折叠头缺可读的 label`);
  }
  // chevron 是装饰：展开状态已由 header 表达，别让读屏再念一遍图标名
  for (const file of ['src/workspace/screen/AgentPlanPanel.js', 'src/workspace/screen/TurnSummaryPanel.js']) {
    const source = read(file);
    assert.ok(source.includes('accessibilityElementsHidden'), `${file}: chevron 未对读屏隐藏`);
    assert.ok(source.includes('importantForAccessibility="no"'), `${file}: chevron 未对 Android 读屏隐藏`);
  }
});

test('消息列表：只有多选态才把消息当按钮，且旧 hint 键已退役', async () => {
  const source = read('src/chat/MessageList.js');
  assert.ok(
    source.includes('accessible={messageSelectionOpen}'),
    '非多选态必须 accessible={false}（否则读屏把每条消息都念成按钮）'
  );
  assert.ok(
    source.includes("accessibilityRole={messageSelectionOpen ? 'button' : undefined}"),
    'role 必须随多选态开关'
  );
  assert.ok(source.includes("t('chat.list.selectMessageA11y')"), '多选态用「选择/取消选择」文案');
  assert.equal(source.includes('longPressSelectA11y'), false, '退役的 hint 键不得再被引用');

  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  assert.equal('chat.list.longPressSelectA11y' in zhCN, false);
  assert.equal('chat.list.longPressSelectA11y' in en, false);
  assert.ok(zhCN['chat.list.selectMessageA11y'] && en['chat.list.selectMessageA11y'], '新键双语齐备');
});

test('输入区：发送/停止/补充指令/移除附件都带 role（此前只有 label）', () => {
  const source = read('src/chat/ChatComposer.js');
  for (const key of [
    'chat.composer.a11y.steer',
    'chat.composer.a11y.stop',
    'chat.composer.a11y.send',
  ]) {
    const at = source.indexOf(`'${key}'`);
    assert.notEqual(at, -1, `${key} 未被使用`);
    // 同一开标签内必须同时有 accessibilityRole（label 与 role 成对出现才算统一）
    const openTagStart = source.lastIndexOf('<TouchableOpacity', at);
    const between = source.slice(openTagStart, at);
    assert.ok(
      between.includes('accessibilityRole="button"'),
      `${key}: 有 label 无 role（同文件其它按钮都有，口径不统一）`
    );
  }
  // 移除附件键改走共享的 IconButton（自带 accessibilityRole="button" + 按压缩放 +
  // hitSlop），这里钉「别再手写 TouchableOpacity」——手写就得自己记得补 role。
  const at = source.indexOf("t('chat.composer.a11y.removeAttachment'");
  assert.notEqual(at, -1, 'removeAttachment 未被使用');
  const tagStart = source.lastIndexOf('<', at);
  assert.ok(
    source.slice(tagStart, at).startsWith('<IconButton'),
    '移除附件应走 IconButton（共享组件自带 role，别再手写）'
  );
  assert.ok(source.includes("from '../ui/index.js'"), 'IconButton 从共享 UI 入口导入');
});
