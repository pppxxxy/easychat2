// 真实 `ChatComposer` 的渲染测试（不再用形状等价的假组件）。
//
// 背景：机制 3（输入下沉到 store）此前的证据是「渲染一棵**形状与 ChatScreen 等价**的
// 树」。那证明了机制本身，但证明不了**接线**——真实组件有没有真的订阅、宿主有没有真的
// 不订阅、受控输入会不会回退旧值，只有渲染真组件才算数。
//
// 这个文件补上那一层：渲染的是 src/chat/ChatComposer.js 本体，配真实 inputStore、
// 真实 ThemeContext/I18nContext，只把六个原生包换成 tests/helpers/rn 下的桩。
//
// 能验证什么 / 不能验证什么（诚实边界）：
//   ✅ 组件逻辑、条件分支、回调是否接线、渲染次数、受控值是否跟上 store
//   ❌ 布局、尺寸、手势、字体、原生模块行为（桩只投影成宿主节点，不算样式）
//
// 选择器纪律（踩过两个坑，别退回）：
//   ① 只认**宿主节点**（typeof node.type === 'string'）。无障碍属性会沿组件层级层层
//      透传，按 props 匹配会把 IconButton / PressScaleTouchable / TouchableOpacity /
//      宿主节点各算一次——两个附件曾数出 8 个「移除」键。
//   ② 文案一律用 i18n key 取，不写「包含某个中文子串」。曾用 includes('录音') 匹配
//      「录制语音消息」而永远匹配不上（录/音之间隔了两个字）。
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

const { translate } = await import('../src/i18n/index.js');
const ChatComposer = (await import('../src/chat/ChatComposer.js')).default;
const {
  __listenerCountForTests,
  __resetInputForTests,
  getInput,
  setInput,
  useInput,
} = await import('../src/chat/inputStore.js');

const noop = () => {};
const A11Y = 'chat.composer.a11y.';
// 不挂 Provider：useTheme()/useTranslation() 的无 Provider 回退就是 zh-CN + 默认主题，
// 与 App 首次启动一致（见 tests/helpers/rn/*-context-stub.mjs）。
const t = key => translate('zh-CN', key);

function baseProps(overrides = {}) {
  return {
    quoteTarget: null,
    quoteLocked: false,
    onCancelQuote: noop,
    bgUri: null,
    attachments: [],
    attachLocked: false,
    onRemoveAttachment: noop,
    isSending: false,
    inputDisabled: false,
    steeringEnabled: false,
    onPickAttachment: noop,
    onChangeInput: noop,
    inputFocused: false,
    onInputFocus: noop,
    onInputBlur: noop,
    onSelectionChange: noop,
    onOpenSticker: noop,
    onOpenFullScreen: noop,
    fullScreenDisabled: false,
    onStop: noop,
    onSend: noop,
    voiceEnabled: false,
    recording: false,
    onStartVoice: noop,
    onStopVoice: noop,
    onCancelVoice: noop,
    ...overrides,
  };
}

function render(props = {}) {
  let renderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ChatComposer, baseProps(props)));
  });
  return renderer;
}

// 宿主节点里的唯一 `TextInput`（ChatComposer 只渲染一个，多于一个说明结构变了，直接炸）。
function inputOf(renderer) {
  const inputs = renderer.root.findAllByType('TextInput');
  assert.equal(inputs.length, 1, `ChatComposer 应只有一个 TextInput，实际 ${inputs.length} 个`);
  return inputs[0];
}

// 按无障碍标签找**可点宿主节点**（一个按钮恰好一个）。
function pressables(renderer, label) {
  return renderer.root.findAll(node => typeof node.type === 'string'
    && node.props
    && node.props.accessibilityLabel === label
    && typeof node.props.onPress === 'function');
}

function pressable(renderer, label) {
  const found = pressables(renderer, label);
  assert.equal(found.length, 1, `期望恰好一个「${label}」，实际 ${found.length} 个`);
  return found[0];
}

function countLabel(renderer, label) {
  return renderer.root.findAll(node => typeof node.type === 'string'
    && node.props && node.props.accessibilityLabel === label).length;
}

test.beforeEach(() => {
  __resetInputForTests();
});

// ---------------------------------------------------------------------------
// 1. 受控输入：真实组件必须跟上 store（这是「敲字看得见」的全部依据）
// ---------------------------------------------------------------------------

test('真实 ChatComposer：TextInput 的 value 来自 store，写入后立即跟上', () => {
  const renderer = render();
  assert.equal(inputOf(renderer).props.value, '', '初始应为空串（受控，不是 undefined）');

  act(() => { setInput('你'); });
  assert.equal(inputOf(renderer).props.value, '你', '写入后必须立刻显示新值');

  act(() => { setInput('你好'); });
  assert.equal(inputOf(renderer).props.value, '你好');

  // 受控输入最怕的失败模式：回退旧值。再连按几次，值必须始终等于 store。
  act(() => { setInput('你好呀'); });
  act(() => { setInput('你好呀！'); });
  assert.equal(inputOf(renderer).props.value, '你好呀！');
  assert.equal(getInput(), '你好呀！', 'store 与渲染值必须一致');

  renderer.unmount();
});

test('真实 ChatComposer：onChangeText 原样转交给 onChangeInput（不自己吞字、不改写）', () => {
  const seen = [];
  const renderer = render({ onChangeInput: value => seen.push(value) });
  const input = inputOf(renderer);

  // 模拟用户输入：RN 的 TextInput 每次输入都回调完整新值。
  // ⚠️ 测试值**必须带前后空格和大小写**：只用纯中文测不出「组件偷偷 trim / 改大小写
  // 再上报」这种注入（中文没有大小写、也没有空格），那样的断言是假绿——已实测：
  // 把 onChangeText 改成 value => onChangeInput(value.trim()) 后原测试仍然全绿。
  act(() => { input.props.onChangeText('  aBc '); });
  act(() => { input.props.onChangeText('  aBc  def  '); });

  assert.deepEqual(
    seen,
    ['  aBc ', '  aBc  def  '],
    '每个字符都必须原样上报（含前后空格、大小写）——否则用户打字会被静默改写'
  );

  // onChangeText 只上报，不改 store —— 写 store 是宿主的职责（onInputChange 里做）。
  // 这条钉住「组件不得私自写 store」，否则草稿/去抖逻辑会被绕过。
  assert.equal(getInput(), '', '组件自己不应写 store');

  renderer.unmount();
});

test('真实 ChatComposer：卸载后不再订阅（不泄漏监听器）', () => {
  const before = __listenerCountForTests();
  const renderer = render();
  assert.equal(__listenerCountForTests(), before + 1, '挂载后应恰好新增一个订阅者');

  act(() => { renderer.unmount(); });
  assert.equal(__listenerCountForTests(), before, '卸载后必须退订');

  act(() => { setInput('卸载之后'); });
  assert.equal(getInput(), '卸载之后', 'store 是模块级的，写入本身仍生效');
});

// ---------------------------------------------------------------------------
// 2. 渲染计数：真组件敲字时，宿主与它的 28 个未 memo 子组件一次都不许重渲染
// ---------------------------------------------------------------------------

test('真实 ChatComposer：敲字只重渲染输入区，宿主与 28 个未 memo 子组件不动', () => {
  __resetInputForTests();
  const counts = { host: 0, children: 0 };

  function Child() {
    counts.children += 1;
    return React.createElement('child');
  }

  // 宿主等价于 ChatScreen：**只调用期读取**，不订阅。
  function Host() {
    counts.host += 1;
    const peek = getInput();
    return React.createElement(
      'host',
      { peek },
      Array.from({ length: 28 }, (_, index) => React.createElement(Child, { key: index })),
      React.createElement(ChatComposer, baseProps())
    );
  }

  let renderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Host));
  });

  assert.equal(counts.host, 1, '宿主挂载渲染一次');
  assert.equal(counts.children, 28, '28 个子组件各渲染一次');
  assert.equal(renderer.root.findAllByType('TextInput').length, 1, '真组件的输入框应挂在这棵树上');

  act(() => { setInput('a'); });
  act(() => { setInput('ab'); });
  act(() => { setInput('abc'); });

  assert.equal(counts.host, 1, '宿主不得因输入变化而重渲染（这是整个改造的全部意义）');
  assert.equal(counts.children, 28, '宿主没重渲染 ⇒ 28 个未 memo 子组件一个都不该重渲染');
  // 而输入区必须跟上（否则就是「优化成功但功能坏了」）
  assert.equal(renderer.root.findAllByType('TextInput')[0].props.value, 'abc');

  renderer.unmount();
});

test('负向基准：宿主也订阅时，3 次输入会让 28 个子组件重渲染 3 轮（改造前的情形）', () => {
  __resetInputForTests();
  const counts = { host: 0, children: 0 };

  function Child() {
    counts.children += 1;
    return React.createElement('child');
  }

  // 错误写法：宿主在渲染期订阅（= 改造前 input 是 ChatScreen 的 useState）
  function SubscribingHost() {
    counts.host += 1;
    useInput();
    return React.createElement(
      'host',
      null,
      Array.from({ length: 28 }, (_, index) => React.createElement(Child, { key: index })),
      React.createElement(ChatComposer, baseProps())
    );
  }

  let renderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SubscribingHost));
  });
  assert.equal(counts.children, 28);

  act(() => { setInput('a'); });
  act(() => { setInput('ab'); });
  act(() => { setInput('abc'); });

  assert.equal(counts.host, 4, '订阅版宿主：挂载 + 3 次输入 = 4 次');
  assert.equal(counts.children, 4 * 28, '28 个子组件被连带重渲染 4 轮');

  renderer.unmount();
});

// ---------------------------------------------------------------------------
// 3. 发送键：可用态由「输入非空 or 有附件」决定（真组件、真 store）
// ---------------------------------------------------------------------------

test('真实 ChatComposer：发送键按 store 里的值决定可用态，敲字后自动解禁', () => {
  const sent = [];
  const renderer = render({ onSend: () => sent.push(getInput()) });
  const sendLabel = t(`${A11Y}send`);

  assert.equal(pressable(renderer, sendLabel).props.disabled, true, '空输入时发送键应禁用');

  act(() => { setInput('   '); }); // 全空白也算空（trim 判据）
  assert.equal(pressable(renderer, sendLabel).props.disabled, true, '全空白仍是禁用');

  act(() => { setInput('你好'); });
  assert.equal(pressable(renderer, sendLabel).props.disabled, false, '有内容应解禁');

  act(() => { pressable(renderer, sendLabel).props.onPress(); });
  assert.deepEqual(sent, ['你好'], 'onPress 应把当前文本交给 onSend');

  // 发完清空（宿主会调 setInput('')）→ 回到禁用
  act(() => { setInput(''); });
  assert.equal(pressable(renderer, sendLabel).props.disabled, true);

  renderer.unmount();
});

test('真实 ChatComposer：有附件时即便输入为空也能发送', () => {
  const renderer = render({
    attachments: [{ id: 'a1', kind: 'image', uri: 'file:///x.png', name: 'x.png' }],
  });
  assert.equal(pressable(renderer, t(`${A11Y}send`)).props.disabled, false, '有附件应解禁');
  renderer.unmount();
});

// ---------------------------------------------------------------------------
// 4. 补充指令（steering）：只在「正在发送 + 本轮可注入 + 输入非空」时出现
// ---------------------------------------------------------------------------

test('真实 ChatComposer：steering 键的三个条件缺一不可', () => {
  const steerLabel = t(`${A11Y}steer`);

  // 条件全不满足：普通发送态
  let renderer = render({ isSending: false, steeringEnabled: true });
  act(() => { setInput('文字'); });
  assert.equal(countLabel(renderer, steerLabel), 0, '不在发送中 ⇒ 无 steering 键');
  renderer.unmount();
  __resetInputForTests();

  // 正在发送但本轮不可注入：只有停止键
  renderer = render({ isSending: true, steeringEnabled: false });
  act(() => { setInput('文字'); });
  assert.equal(countLabel(renderer, steerLabel), 0, '未开启注入 ⇒ 无 steering 键');
  renderer.unmount();
  __resetInputForTests();

  // 正在发送 + 可注入 + 输入为空：仍无 steering 键
  renderer = render({ isSending: true, steeringEnabled: true });
  assert.equal(countLabel(renderer, steerLabel), 0, '输入为空 ⇒ 无 steering 键');

  // 输入非空后才出现，且与停止键并存
  act(() => { setInput('补充一句'); });
  assert.equal(countLabel(renderer, steerLabel), 1, '三条件齐备时应出现 steering 键');
  assert.equal(countLabel(renderer, t(`${A11Y}stop`)), 1, '停止键应仍在（steering 不打断本轮）');
  renderer.unmount();
});

test('真实 ChatComposer：发送中且开启注入时，输入框仍可编辑（steering 不打字就没意义）', () => {
  const renderer = render({ isSending: true, steeringEnabled: true, inputDisabled: true });
  assert.equal(inputOf(renderer).props.editable, true, 'steeringNow 时应忽略 inputDisabled');

  const plain = render({ isSending: true, steeringEnabled: false, inputDisabled: true });
  assert.equal(inputOf(plain).props.editable, false, '未开启注入时 inputDisabled 照旧生效');
  plain.unmount();

  renderer.unmount();
});

// ---------------------------------------------------------------------------
// 5. 引用条 / 附件条 / 录音条 / 长按全屏
// ---------------------------------------------------------------------------

test('真实 ChatComposer：长按输入框触发全屏编辑，禁用时不触发', () => {
  let opened = 0;
  let renderer = render({ onOpenFullScreen: () => { opened += 1; } });
  act(() => { inputOf(renderer).props.onLongPress(); });
  assert.equal(opened, 1, '长按应触发全屏编辑');
  renderer.unmount();

  opened = 0;
  renderer = render({ onOpenFullScreen: () => { opened += 1; }, fullScreenDisabled: true });
  act(() => { inputOf(renderer).props.onLongPress(); });
  assert.equal(opened, 0, 'fullScreenDisabled 时长按不应触发');
  renderer.unmount();
});

test('真实 ChatComposer：引用条渲染原文，取消键回调 onCancelQuote', () => {
  let cancelled = 0;
  const renderer = render({
    quoteTarget: { name: '角色甲', text: '被引用的原文' },
    onCancelQuote: () => { cancelled += 1; },
  });

  // 引用条正文走 JSX 子节点，不是 prop——从渲染树里找文本
  const flat = JSON.stringify(renderer.toJSON());
  assert.ok(flat.includes('被引用的原文'), '引用条应渲染被引用文本');
  assert.ok(flat.includes('角色甲'), '引用条应渲染引用对象名字');

  act(() => { pressable(renderer, t(`${A11Y}cancelQuote`)).props.onPress(); });
  assert.equal(cancelled, 1, '取消引用应回调 onCancelQuote');

  renderer.unmount();
});

test('真实 ChatComposer：附件条逐项渲染，移除键把该附件 id 交回宿主', () => {
  const removed = [];
  const renderer = render({
    attachments: [
      { id: 'img', kind: 'image', uri: 'file:///a.png', name: 'a.png' },
      { id: 'doc', kind: 'file', name: 'b.pdf' },
      { id: 'vid', kind: 'video', name: 'c.mp4' },
    ],
    onRemoveAttachment: id => removed.push(id),
  });

  const flat = JSON.stringify(renderer.toJSON());
  assert.ok(flat.includes('a.png') && flat.includes('b.pdf') && flat.includes('c.mp4'), '三个附件都应渲染出名字');

  // 标签带 {name} 占位符，逐个附件各不相同 —— 顺带验证了占位符替换
  act(() => { pressable(renderer, translate('zh-CN', `${A11Y}removeAttachment`, { name: 'b.pdf' })).props.onPress(); });
  assert.deepEqual(removed, ['doc'], '移除键应把该附件 id（不是名字）交回宿主');

  act(() => { pressable(renderer, translate('zh-CN', `${A11Y}removeAttachment`, { name: 'a.png' })).props.onPress(); });
  assert.deepEqual(removed, ['doc', 'img']);

  renderer.unmount();
});

test('真实 ChatComposer：附件锁定时移除键禁用（不静默失效，是明确禁用）', () => {
  const renderer = render({
    attachments: [{ id: 'a1', kind: 'file', name: 'a.pdf' }],
    attachLocked: true,
  });
  const removeLabel = translate('zh-CN', `${A11Y}removeAttachment`, { name: 'a.pdf' });
  assert.equal(pressable(renderer, removeLabel).props.disabled, true);
  renderer.unmount();
});

test('真实 ChatComposer：录音条与录音/停止录音键随 recording 切换', () => {
  // 非录音、开启语音：出现「录制语音消息」键
  let renderer = render({ voiceEnabled: true, recording: false });
  assert.equal(countLabel(renderer, t(`${A11Y}record`)), 1, '非录音时应出现录音键');
  assert.equal(countLabel(renderer, t(`${A11Y}stopRecord`)), 0, '非录音时不应出现停止录音键');
  renderer.unmount();

  // 录音中：出现停止录音键 + 录音条正文，录音键消失
  renderer = render({ voiceEnabled: true, recording: true });
  assert.equal(countLabel(renderer, t(`${A11Y}stopRecord`)), 1, '录音时应出现停止录音键');
  assert.equal(countLabel(renderer, t(`${A11Y}record`)), 0, '录音时不应再出现「开始录音」键');
  assert.ok(JSON.stringify(renderer.toJSON()).includes(t('chat.composer.recording')), '录音条应显示录音中提示');
  assert.equal(countLabel(renderer, t(`${A11Y}cancelRecord`)), 1, '录音条应有取消键');
  renderer.unmount();

  // 语音未开启：两个键都不出现（占位不该存在）
  renderer = render({ voiceEnabled: false, recording: true });
  assert.equal(countLabel(renderer, t(`${A11Y}stopRecord`)), 0, '语音关闭时不应出现停止录音键');
  renderer.unmount();
});

test('真实 ChatComposer：inputDisabled 时附件/表情/发送键都禁用', () => {
  const renderer = render({ inputDisabled: true });
  for (const key of ['attach', 'sticker', 'send']) {
    assert.equal(pressable(renderer, t(`${A11Y}${key}`)).props.disabled, true, `${key} 应禁用`);
  }
  renderer.unmount();
});

test('真实 ChatComposer：bgUri 走 overlay 分支（背景图模式下换一套样式）', () => {
  const plain = render({ bgUri: null });
  const overlay = render({ bgUri: 'file:///bg.png' });
  const styleOf = renderer => JSON.stringify(renderer.toJSON().props.style);
  assert.notEqual(styleOf(plain), styleOf(overlay), '背景图模式应产生不同的输入条样式');
  plain.unmount();
  overlay.unmount();
});
