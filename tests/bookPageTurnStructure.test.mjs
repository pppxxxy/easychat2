// 翻页方式切换的结构守卫（2026-10-06「旋转翻页下点切换阅读方式闪退」修复）。
// 根因：四种翻页模式给同一个 useNativeDriver 的 Animated.View 供四种不同结构
// 的动画属性，curl→fade 是唯一「transform 整体撤掉换 opacity」的原地交换——
// RN 0.81 原生动画换结构是先挂新后卸旧、restoreDefaultValues 夹中间，
// Android 侧帧延迟的值传播可能踩到拆一半的旧图（IllegalArgumentException）。
// 修复：分页 Animated.View 以 pageTurn 为 key 重挂（结构交换走 React 规范
// 卸载/挂载路径），进度归零移到提交后的 effect。本守卫钉住这些不变量。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = readFileSync(path.join(HERE, '..', 'src', 'books', 'BookReaderView.js'), 'utf8');
const SETTINGS = readFileSync(path.join(HERE, '..', 'src', 'books', 'readerSettings.js'), 'utf8');

test('分页 Animated.View 必须以 pageTurn 为 key（模式切换 = 重挂，禁止原地换结构）', () => {
  const start = SCREEN.indexOf('<Animated.View');
  assert.ok(start > 0, '找不到分页 Animated.View');
  const head = SCREEN.slice(start, start + 200);
  assert.ok(
    head.includes('key={pageTurn}'),
    '分页 Animated.View 必须带 key={pageTurn}：重挂是消灭原生节点图原地交换的唯一正道'
  );
  assert.ok(head.includes('pageAnimStyle'), '锚定的是动画宿主视图');
});

test('cyclePageTurn：先停表再换状态，且不再原地归零（复位移交 effect）', () => {
  const start = SCREEN.indexOf('const cyclePageTurn');
  const end = SCREEN.indexOf('}, [pageAnim, pageTurn, t]);', start);
  assert.ok(start > 0 && end > start, 'cyclePageTurn 定位失败');
  const region = SCREEN.slice(start, end);
  const stopAt = region.indexOf('pageAnim.stopAnimation()');
  const setAt = region.indexOf('setPageTurn(next)');
  assert.ok(stopAt > 0, '应保留 stopAnimation（防护在途动画窗口）');
  assert.ok(setAt > stopAt, '必须先停表再换状态');
  // 用 'pageAnim.setValue(' 做代码级锚：裸 'setValue(' 会被 cyclePageTurn 的
  // 注释文字（提到旧方案 setValue(0)）误命中（substring 陷阱）
  assert.ok(!region.includes('pageAnim.setValue('), 'cyclePageTurn 不得再原地归零（帧延迟传播是崩溃另一半成因）');
});

test('进度归零唯一存在于提交后的 effect（[pageAnim, pageTurn] 依赖）', () => {
  const count = (SCREEN.match(/pageAnim\.setValue\(0\)/g) || []).length;
  assert.equal(count, 1, 'setValue(0) 应只出现一次（复位职责单点化）');
  assert.ok(
    SCREEN.includes('useEffect(() => {\n    pageAnim.setValue(0);\n  }, [pageAnim, pageTurn]);'),
    '归零必须在 key 重挂提交后的 effect 里执行'
  );
});

test('PAGE_TURN_MODES 单源：BookReaderView 从 readerSettings 导入，不得本地重定义', () => {
  assert.ok(SCREEN.includes('PAGE_TURN_MODES,') || SCREEN.includes('PAGE_TURN_MODES }'), '应从 readerSettings 导入 PAGE_TURN_MODES');
  assert.ok(
    !/const PAGE_TURN_MODES\s*=/.test(SCREEN),
    '不得本地重定义模式数组（防两处漂移）'
  );
  assert.ok(
    SETTINGS.includes("['tap', 'slide', 'curl', 'fade']"),
    'readerSettings 的轮换顺序应与既定交互一致'
  );
});
