// 「长按选择复制」的渲染契约测试（2026-10-18 用户实测报告）。
//
// 用户诉求：助手回复要能**直接长按**选中文字复制（微信式），而不是先点「···」再点
// 「选择文字」两步走。
//
// 这个文件钉三件事：
//   ① 三条 Markdown 渲染路径（聊天气泡 / 预览组件 / 代码块）产出的正文 Text 都带
//      selectable —— 这是「长按能弹系统菜单」的唯一前提；
//   ② 规则用的是 node.content 而不是 children —— 用错会把正文渲染成空白（实测过的坑）；
//   ③ 既有两步入口（SelectionTextModal）与富组件兜底不被破坏。
//
// 为什么不在这里断言「系统菜单真的弹了」：那是原生层行为，Node 里没有系统菜单。
// selectable 就是 RN 对这件事的全部契约，测试到这一层为止；真机矩阵由用户执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { setupNativeStubs } from './helpers/rn/setup.mjs';

setupNativeStubs();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const React = require('react');
const TestRenderer = require('react-test-renderer');
const act = TestRenderer.act || React.act;
const babel = require('@babel/core');

// ---- react-native-markdown-display 的加载器 ----
// 它的入口 src/index.js 含 JSX，生产里由 Metro 处理；Node 里要现场转一遍。
const pkgRoot = path.resolve('node_modules/react-native-markdown-display');
const entry = path.join(pkgRoot, 'src/index.js');

function loadMarkdownPackage() {
  const seen = new Map();
  function loadFile(absPath) {
    if (seen.has(absPath)) return seen.get(absPath);
    const module = { exports: {} };
    seen.set(absPath, module.exports);
    const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
      babelrc: false, configFile: false, sourceType: 'module', filename: absPath, retainLines: true,
      presets: [
        [require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }],
        [require.resolve('@babel/preset-react'), { runtime: 'classic' }],
      ],
    }).code;
    const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
    const localRequire = spec => {
      if (!spec.startsWith('.')) return require(spec);
      const target = path.resolve(path.dirname(absPath), spec);
      for (const candidate of [target, `${target}.js`, path.join(target, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate.endsWith('.js') ? loadFile(candidate) : require(candidate);
        }
      }
      return require(target);
    };
    fn(localRequire, module, module.exports, absPath, path.dirname(absPath));
    seen.set(absPath, module.exports);
    return module.exports;
  }
  return loadFile(entry);
}

const markdownPkg = loadMarkdownPackage();
const Markdown = markdownPkg.default || markdownPkg;

const { selectableMarkdownRules, createMarkdownStyles } = await import('../src/chat/assistantRender.js');
const { getTheme } = await import('../src/theme/themes.js');
const { tokens } = await import('../src/theme/tokens.js');

function render(element) {
  let renderer;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer;
}

// 把整棵树的可见文字拼起来（用于断言「字没丢」）
function collectText(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
  if (typeof node === 'string') { out.push(node); return out; }
  collectText(node.children, out);
  return out;
}

// 「这段文字用户能不能选中」= 它上面有没有 selectable 的 Text 祖先。
// 这才是真实契约：RN 里 selectable 落在某个 Text 上，就让它整棵子树的文字可被选择，
// 所以断言「每个文本串都有 selectable 祖先」比「每个 Text 节点都带 selectable」更准
// （后者会把 strong/em 这类纯包装节点也算成缺陷，而那些节点的孩子已经可选）。
function textIsSelectable(node, selectableAncestor = false) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(child => textIsSelectable(child, selectableAncestor));
  if (typeof node === 'string') return [{ text: node, selectable: selectableAncestor }];
  const isText = node.type === 'Text';
  const next = selectableAncestor || (isText && node.props && node.props.selectable === true);
  return textIsSelectable(node.children, next);
}

// ---- ① 规则本体 ----

test('规则本体：text 用 node.content（不是 children），且带 selectable', () => {
  const rule = selectableMarkdownRules.text;
  assert.equal(typeof rule, 'function', 'text 必须是函数规则');

  const node = { key: 'k1', content: '正文内容' };
  const element = rule(node, [], [], { text: { color: 'red' } }, {});
  assert.equal(element.props.selectable, true, 'text 规则必须带 selectable: true');
  assert.deepEqual(element.props.children, '正文内容', 'text 规则必须渲染 node.content');

  // 这是最关键的一条：若把 children 当内容传，叶子节点 children 为空 → 正文消失。
  const withChildren = rule(node, [], [], { text: {} }, {});
  assert.notDeepEqual(withChildren.props.children, [], '绝不能渲染 children 数组当正文');
});

test('规则本体：textgroup 也带 selectable（块级容器，跨叶子选择需要它）', () => {
  const rule = selectableMarkdownRules.textgroup;
  assert.equal(typeof rule, 'function');
  const element = rule({ key: 'g1' }, ['a', 'b'], [], { textgroup: {} });
  assert.equal(element.props.selectable, true, 'textgroup 规则必须带 selectable: true');
});

// ---- ② 端到端：真实 Markdown 渲染里正文确实可选且不丢字 ----

const SAMPLES = [
  ['纯文本', '这是一段普通的助手回复'],
  ['带加粗', '开头 **加粗** 结尾'],
  ['标题与段落', '# 标题\n\n段落文字'],
  ['列表', '- 第一项\n- 第二项'],
  ['引用', '> 被引用的句子'],
  ['中英混排', 'hello 你好 world'],
  ['行内代码', '执行 `npm test` 即可'],
  ['链接', '见 [文档](https://example.com)'],
];

// 列表标记（•、1.）是装饰而不是正文：用户不会想单独复制一个圆点，
// 且 RN 的选择本来就是按 Text 粒度，跨 Text 选不成立。这里显式豁免并说明原因。
const DECORATIVE = new Set(['•', '1.', '2.']);

for (const [name, source] of SAMPLES) {
  test(`端到端：${name} 渲染后正文都被 selectable 覆盖，且原始文字不丢`, () => {
    const styles = createMarkdownStyles(getTheme('dark'), { scaled: value => value }, tokens);
    const renderer = render(React.createElement(Markdown, { style: styles, rules: selectableMarkdownRules }, source));

    // (a) 字没丢：把所有可见文字拼起来，逐个词核对
    const joined = collectText(renderer.toJSON()).join('');
    const expectedPieces = source
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*/g, '')
      .replace(/^[-*>]\s*/gm, '')
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    for (const piece of expectedPieces) {
      assert.ok(joined.includes(piece), `渲染文字应包含「${piece}」，实际拼出：${joined}`);
    }

    // (b) 每段正文都在 selectable 覆盖范围内
    const leaves = textIsSelectable(renderer.toJSON());
    assert.ok(leaves.length > 0, '应渲染出文字');
    const uncovered = leaves.filter(leaf => !leaf.selectable && !DECORATIVE.has(leaf.text.trim()));
    assert.deepEqual(
      uncovered,
      [],
      `这些文字没有 selectable 祖先（长按选不中）：${JSON.stringify(uncovered)}`
    );
    renderer.unmount();
  });
}

test('端到端：表格不被 text 规则打乱（table 规则仍由调用方覆盖）', () => {
  const styles = createMarkdownStyles(getTheme('dark'), { scaled: value => value }, tokens);
  const source = '| 列一 | 列二 |\n| --- | --- |\n| a | b |';
  const renderer = render(React.createElement(Markdown, { style: styles, rules: selectableMarkdownRules }, source));
  const flat = JSON.stringify(renderer.toJSON());
  assert.ok(flat.includes('列一') && flat.includes('a'), '表格内容应渲染出来');
  renderer.unmount();
});

// ---- ③ 源码契约：三条路径真的用了这套规则 ----

test('源码契约：MessageBubble / AssistantMessageBody 都并入 selectableMarkdownRules', () => {
  for (const rel of ['src/chat/MessageBubble.js', 'src/chat/AssistantMessageBody.js']) {
    const source = fs.readFileSync(rel, 'utf8');
    assert.ok(
      /\.\.\.selectableMarkdownRules/.test(source),
      `${rel} 必须把 selectableMarkdownRules 并入 markdownRules（否则该路径长按仍选不中）`
    );
    assert.ok(
      /import[^;]*selectableMarkdownRules/.test(source),
      `${rel} 必须从 assistantRender.js 导入 selectableMarkdownRules`
    );
  }
});

test('源码契约：代码块与斜杠按钮的自渲染 Text 也带 selectable', () => {
  // 代码块：Markdown 的 code_block/fence 由调用方规则覆盖，那些 Text 需要各自补
  const bubble = fs.readFileSync('src/chat/MessageBubble.js', 'utf8');
  assert.ok(
    /ruleStyles\[styleKey\]\][^>]*selectable/.test(bubble),
    'MessageBubble 代码块内的 Text 必须 selectable'
  );
  const preview = fs.readFileSync('src/chat/AssistantMessageBody.js', 'utf8');
  for (const key of ['code_block', 'fence']) {
    assert.ok(
      new RegExp(`ruleStyles\\.${key}\\]\\}[^>]*selectable`).test(preview),
      `AssistantMessageBody 的 ${key} Text 必须 selectable`
    );
  }
  // 斜杠命令按钮：defaultTextProps 不作用到自定义 renderer 内部
  assert.ok(
    /styles\.panelButtonText\}[^>]*selectable/.test(bubble),
    'MessageBubble 斜杠按钮文案必须 selectable（自定义 renderer 绕过了 defaultTextProps）'
  );
});

test('源码契约：用户消息正文也带 selectable', () => {
  const bubble = fs.readFileSync('src/chat/MessageBubble.js', 'utf8');
  assert.ok(
    /<Text style=\{styles\.messageText\} selectable>/.test(bubble),
    '用户消息正文必须 selectable（微信里两侧气泡都可选）'
  );
});

// ---- ④ 既有兜底不被破坏 ----

test('兜底仍在：两步入口（··· → 选择文字 → SelectionTextModal）未被改动', () => {
  const bubble = fs.readFileSync('src/chat/MessageBubble.js', 'utf8');
  assert.ok(
    /onSelectText\?\.\(plainText\)/.test(bubble),
    '「选择文字」菜单项必须仍把 plainText 交给 onSelectText'
  );
  const modal = fs.readFileSync('src/chat/SelectionTextModal.js', 'utf8');
  assert.ok(/selectable/.test(modal), 'SelectionTextModal 内部仍应是可选中的 Text');
  // RichHtmlMessage 走 WebView，本就不在 selectable 的作用域内——留作兜底入口
  const chatScreen = fs.readFileSync('src/ChatScreen.js', 'utf8');
  assert.ok(/<SelectionTextModal/.test(chatScreen), 'ChatScreen 必须仍挂载 SelectionTextModal');
});

test('未引入手势冲突：没有给气泡新增 onLongPress（选择交给系统，不抢手势）', () => {
  const bubble = fs.readFileSync('src/chat/MessageBubble.js', 'utf8');
  assert.ok(
    !/onLongPress/.test(bubble),
    'MessageBubble 不得新增 onLongPress——长按要交给系统文本选择，自建长按会与它抢手势'
  );
});
