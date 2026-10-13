// Sheet（共享弹窗外壳）与它的外壳策略。
//
// 取舍说明：仓库没有组件渲染基建——react-native 在 Node 下 import 不进来（Flow 语法直接
// SyntaxError），也没有 react-test-renderer。所以这里分两层：
//   1. **行为**测试：Sheet 真正不同的两处决策（背景层模式 → 点空白是否关闭/是否键盘抬升；
//      头部三态 → 自定义节点/共享 SheetHeader/无）抽成 src/ui/sheetLayout.js 的纯函数，
//      用真断言覆盖全部取值与非法输入；
//   2. **结构**断言：只钉已修复的回归——16 个弹窗曾 0/16 漏配模态无障碍标记，这层保证
//      收进 Sheet.js 后不再漏；以及「不得用 visible 提前短路 Modal」这条会吃掉 iOS 关闭
//      动画的写法。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveSheetBackdrop, resolveSheetDismissArea, resolveSheetHeaderKind, SHEET_BACKDROP_MODES } from '../src/ui/sheetLayout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');
const SHEET = read('src/ui/Sheet.js');
// 行注释里会引用反例写法（如 `visible ? <Modal/> : null`），判据只认代码：先剥掉整行注释。
const SHEET_CODE = SHEET.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
// 取 JSX 开标签文本（<Card ...>），属性判据只在标签内成立才算数。
const openTag = source => {
  const start = source.indexOf('<Card');
  return start < 0 ? '' : source.slice(start, source.indexOf('>', start));
};

test('背景层模式：三种取值各自决定「点空白是否关闭」与「是否键盘抬升」', () => {
  assert.deepEqual(resolveSheetBackdrop('dismiss'), { dismissOnPress: true, keyboardAvoiding: false });
  assert.deepEqual(resolveSheetBackdrop('static'), { dismissOnPress: false, keyboardAvoiding: false });
  assert.deepEqual(resolveSheetBackdrop('keyboard'), { dismissOnPress: false, keyboardAvoiding: true });
  // 键盘模式也必须允许关闭（否则键盘弹窗只能靠系统返回键退出）
  assert.equal(resolveSheetBackdrop('keyboard').dismissOnPress, false);
});

test('背景层模式：非法输入回落到 dismiss，不抛异常也不返回 undefined', () => {
  for (const bad of [undefined, null, '', 'DISMISS', 'dismiss ', 'nope', 0, {}, []]) {
    assert.deepEqual(
      resolveSheetBackdrop(bad),
      SHEET_BACKDROP_MODES.dismiss,
      `非法模式 ${JSON.stringify(bad)} 应回落到 dismiss`
    );
  }
});

test('头部三态：显式 header 优先，其次 title 走共享 SheetHeader，都没有则无头部', () => {
  assert.equal(resolveSheetHeaderKind({ header: 'x', title: 'y' }), 'custom', '自定义节点优先');
  assert.equal(resolveSheetHeaderKind({ header: null, title: '标题' }), 'standard');
  assert.equal(resolveSheetHeaderKind({ title: '标题' }), 'standard');
  assert.equal(resolveSheetHeaderKind({ header: null, title: '' }), 'none');
  assert.equal(resolveSheetHeaderKind({}), 'none');
  assert.equal(resolveSheetHeaderKind(), 'none');
  // 0 / false 这类「看起来像空」的节点仍是显式节点（React 允许渲染它们）
  assert.equal(resolveSheetHeaderKind({ header: 0, title: '标题' }), 'custom');
  assert.equal(resolveSheetHeaderKind({ header: false, title: '标题' }), 'custom');
});

test('回归：模态无障碍标记（曾 0/16 漏配）收在 Sheet 一处，两套平台标记都在', () => {
  const cardTag = openTag(SHEET_CODE);
  assert.ok(cardTag, 'Sheet 应有卡片容器 <Card ...>');
  assert.ok(cardTag.includes('accessibilityViewIsModal'), '卡片缺 iOS 的模态标记（读屏会继续读背后内容）');
  assert.ok(cardTag.includes('importantForAccessibility="yes"'), '卡片缺 Android 的模态标记');
  assert.equal(SHEET_CODE.includes('accessibilityViewIsModal'), true);
});

test('回归：不得用 visible 提前短路 Modal（会吃掉 iOS 关闭动画）', () => {
  assert.ok(SHEET_CODE.includes('<Modal'), 'Sheet 渲染 Modal 外壳');
  assert.ok(SHEET_CODE.includes('visible={visible}'), 'visible 原样透传给 Modal');
  assert.ok(SHEET_CODE.includes('transparent'), '背景透明（弹窗浮在内容之上）');
  assert.ok(SHEET_CODE.includes('animationType={animationType}'), '动画类型可配（fade / slide）');
  assert.ok(SHEET_CODE.includes('onRequestClose={onClose}'), 'Android 返回键必须能关闭');
  // 反例：visible ? <Modal/> : null / visible && <Modal/> —— iOS 关闭动画期间
  // Modal 靠 state.isRendered 继续渲染内容（Modal.js:278-284），提前短路会闪没。
  assert.equal(/visible\s*(\?|&&)\s*\(?\s*<Modal/.test(SHEET_CODE), false, '不得按 visible 短路 Modal');
});

test('Sheet 复用共享 SheetHeader，且头部三态接线齐备', () => {
  assert.ok(SHEET_CODE.includes("import SheetHeader from './SheetHeader.js';"), '走共享标题行');
  assert.ok(SHEET_CODE.includes("headerKind === 'standard'"), 'title 路径渲染 SheetHeader');
  assert.ok(SHEET_CODE.includes("headerKind === 'custom'"), 'header 路径渲染自定义节点');
  assert.ok(SHEET_CODE.includes('<SheetHeader title={title} onClose={onClose} onBack={onBack} closeLabel={closeLabel} />'));
  assert.ok(SHEET_CODE.includes('{children}'), '内容透传');
});

// —— R6（2026-10-13 实测回归）：dismiss 背景 Pressable 的后代里，Android 上原生
// 列表收不到触摸流（滚不动、轻点误关）。结构决策抽成纯函数钉行为，组件钉结构。

test('R6 resolveSheetDismissArea：只有 dismiss 语义才谈得上 above', () => {
  assert.equal(resolveSheetDismissArea({ backdrop: { dismissOnPress: true }, dismissArea: 'above' }), 'above');
  assert.equal(resolveSheetDismissArea({ backdrop: { dismissOnPress: true } }), 'wrap', '缺省 = 旧结构');
  assert.equal(resolveSheetDismissArea({ backdrop: { dismissOnPress: true }, dismissArea: 'wrap' }), 'wrap');
  assert.equal(resolveSheetDismissArea({ backdrop: { dismissOnPress: true }, dismissArea: 'nope' }), 'wrap', '非法取值回落旧结构');
  assert.equal(resolveSheetDismissArea({ backdrop: { dismissOnPress: false }, dismissArea: 'above' }), 'wrap',
    'static/keyboard 没有关闭手势，above 无意义');
  assert.equal(resolveSheetDismissArea({}), 'wrap', '坏输入不抛');
  assert.equal(resolveSheetDismissArea(), 'wrap');
});

test('R6 结构：above 分支里卡片不是 dismiss Pressable 的后代', () => {
  // above 分支：View(backdropStyle) 纵排 [Pressable(flex:1, onClose), card]——
  // 关闭手势只落在卡片上方的空白条上。
  const aboveBranch = SHEET_CODE.slice(SHEET_CODE.indexOf("if (area === 'above')"), SHEET_CODE.indexOf('return (\n    <Modal', SHEET_CODE.indexOf("if (area === 'above')")));
  assert.ok(aboveBranch.length > 20, '存在 above 分支');
  assert.ok(aboveBranch.includes('<View style={backdropStyle}>'), 'above 分支背景是纯 View（不认领手势）');
  assert.ok(aboveBranch.includes('onPress={onClose}'), '上方空白条承担关闭');
  assert.ok(aboveBranch.includes('{card}'), '卡片与空白条是兄弟（不是 Pressable 后代）');
  assert.equal(aboveBranch.includes('<Backdrop'), false, 'above 分支不得把卡片包回 dismiss 背景');
  // 旧结构（wrap）路径原样保留——16 个既有弹窗的行为逐字节不变。
  assert.ok(SHEET_CODE.includes('<Backdrop'), '默认仍是背景包卡片');
});

test('R6 结构：模态标记在两条路径共用的卡片上（不得因分支漏一份）', () => {
  // 卡片只构造一次（const card），两种结构共用——上面的 openTag 判据已钉标记；
  // 这里钉「card 被两条路径渲染」这个接线本身。
  assert.ok(SHEET_CODE.includes('const card = ('), '卡片单一构造点');
  const uses = (SHEET_CODE.match(/\{card\}/g) || []).length;
  assert.equal(uses, 2, 'above 与 wrap 两条路径各渲染一次同一个 card');
});

test('R6 接线：回合小结的「全部文件」Sheet 用 above + 列表不吞点击', () => {
  const panel = read('src/workspace/screen/TurnSummaryPanel.js');
  assert.ok(panel.includes('dismissArea="above"'), '底部列表 Sheet 走 above 结构');
  assert.ok(panel.includes('keyboardShouldPersistTaps="handled"'), '列表内点行不先收键盘');
  // 防复发判据：该 Sheet 不得退回 dismiss 默认 + 列表嵌在背景里的旧写法。
  assert.equal(/<Sheet[^>]*backdropMode="dismiss"/.test(panel), false, '不得显式退回 dismiss 包裹');
});
