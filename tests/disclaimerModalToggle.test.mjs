// 免责条款弹窗「简体中文 / English」切换的渲染测试（2026-10-24 用户裁决）。
//
// 渲染真实 `DisclaimerModal`（src/onboarding/disclaimer.js）：无 Provider 时
// useTranslation() 回退 zh-CN + 默认主题，与真实首启一致。
//
// 与 tests/disclaimerContent.test.mjs 的分工：那边钉**条款内容**（中英两份的完备性、
// 结构对齐、单一来源、版本配对）；这里只管**接线**——切换器真的在、真的能切、
// 真的渲染对应语言的条款与管辖语言提示、重开弹窗真的重置回界面语言。
//
// 选择器纪律（与 chatComposerRender.test.mjs 同一套）：只认宿主节点；
// 芯片定位先按文本找 Text 宿主，再沿父链找带 onPress 的祖先，不数组件类型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { setupNativeStubs } from './helpers/rn/setup.mjs';

setupNativeStubs();

// React 19 要求显式声明 act 环境，否则副作用不刷新、并打警告。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const React = require('react');
const TestRenderer = require('react-test-renderer');
const act = TestRenderer.act || React.act;

const DisclaimerModal = (await import('../src/onboarding/disclaimer.js')).default;

// 中文分节版第一节标题（DISCLAIMER_SECTIONS[0].title）/ 英文参考译文第一节标题 / 管辖语言提示。
const ZH_TITLE = '应用性质';
const EN_TITLE = 'Nature of the Application';
const EN_NOTICE = 'For reference only; the Simplified Chinese version governs.';

const noop = () => {};

function renderModal(props = {}) {
  let renderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(DisclaimerModal, { visible: true, onClose: noop, ...props })
    );
  });
  return renderer;
}

function textsOf(renderer) {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && node.type === 'Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .filter(Boolean)
    .join('\n');
}

// 按标签找语言芯片：文字 → 沿父链上溯到第一个带 onPress 的节点。
function chipOf(renderer, label) {
  const textNode = renderer.root
    .findAll(node => (
      typeof node.type === 'string'
      && node.type === 'Text'
      && node.children.filter(child => typeof child === 'string').join('') === label
    ))[0];
  assert.ok(textNode, `找不到标签为「${label}」的语言芯片`);
  let cursor = textNode.parent;
  while (cursor && !(cursor.props && typeof cursor.props.onPress === 'function')) {
    cursor = cursor.parent;
  }
  assert.ok(cursor, `「${label}」芯片没有接 onPress`);
  return cursor;
}

test('免责弹窗默认渲染中文条款，切换器两个芯片都在，中文视图无英文提示', () => {
  const renderer = renderModal();
  const texts = textsOf(renderer);
  assert.ok(texts.includes(ZH_TITLE), '默认（界面语言 zh-CN）应渲染中文分节条款');
  assert.ok(!texts.includes(EN_TITLE), '默认不应渲染英文条款');
  assert.ok(texts.includes('简体中文') && texts.includes('English'), '两个语言芯片都要在');
  assert.ok(!texts.includes(EN_NOTICE), '中文视图不显示管辖语言提示');
});

test('点 English 切到英文参考译文并显示管辖语言提示，点回中文恢复', () => {
  const renderer = renderModal();

  act(() => { chipOf(renderer, 'English').props.onPress(); });
  let texts = textsOf(renderer);
  assert.ok(texts.includes(EN_TITLE), '切英文后应渲染英文参考译文');
  assert.ok(!texts.includes(ZH_TITLE), '切英文后不应再渲染中文条款');
  assert.ok(texts.includes(EN_NOTICE), '英文视图底部应有管辖语言提示');

  act(() => { chipOf(renderer, '简体中文').props.onPress(); });
  texts = textsOf(renderer);
  assert.ok(texts.includes(ZH_TITLE), '切回中文应恢复中文条款');
  assert.ok(!texts.includes(EN_NOTICE), '切回中文后不再显示管辖语言提示');
});

test('重开弹窗后语言重置回界面语言（手动切换只在本次弹窗内生效）', () => {
  const renderer = renderModal();
  act(() => { chipOf(renderer, 'English').props.onPress(); });
  assert.ok(textsOf(renderer).includes(EN_TITLE), '前提：已切到英文');

  act(() => { renderer.update(React.createElement(DisclaimerModal, { visible: false, onClose: noop })); });
  act(() => { renderer.update(React.createElement(DisclaimerModal, { visible: true, onClose: noop })); });

  const texts = textsOf(renderer);
  assert.ok(texts.includes(ZH_TITLE), '重开后应回到界面语言（中文），不残留上次的手动选择');
  assert.ok(!texts.includes(EN_NOTICE), '重开后不应残留英文提示');
});
