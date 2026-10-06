// 面板 Section 组件的 props 接线守卫。
// 背景（2026-10-06 生产崩溃）：ModelParamsModal 声明了 t prop 并在渲染体第一行
// 就调用 t(...)，但壳的调用点漏传 t={t}——组件挂载即渲染（Modal visible=false
// 也照样执行函数体），整个设置页一进就抛 undefined is not a function 白屏。
// 静态可检的形态：组件解构了某个 prop（如 t），壳的对应 JSX 却没传。
// 本测试对 panel/ 全部组件做「声明 prop ⇒ 调用点传参」的最小检查（t 与 styles/theme）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = readFileSync(path.join(HERE, '..', 'src', 'LocalModelPanel.js'), 'utf8');

const COMPONENTS = [
  'ModelsSection.js',
  'AcquireSection.js',
  'ApiServerSection.js',
  'ModelParamsModal.js',
];

// 从组件文件取：组件名 + 解构的 props 名集合（function Name({ ... }) { 的首参）。
function inspectComponent(source, fileName) {
  const declMatch = source.match(/export default function (\w+)\((\{[\s\S]*?\})\)/);
  assert.ok(declMatch, `${fileName} 应有 export default function 声明`);
  const name = declMatch[1];
  const propsBlock = declMatch[2];
  const props = new Set();
  // 逐行解析解构块：形如「  t,」「  styles,」「  busy,」或带默认值
  propsBlock.split('\n').forEach(line => {
    const m = line.trim().match(/^([A-Za-z_$][\w$]*)\s*[,:]/);
    if (m) props.add(m[1]);
  });
  return { name, props, fileName };
}

// 从壳的 JSX 里取 <Name ... /> 的完整元素文本。
function jsxElementInShell(name) {
  const start = SHELL.indexOf(`<${name}`);
  assert.ok(start >= 0, `壳中找不到 <${name}> 的调用点`);
  const end = SHELL.indexOf('/>', start);
  assert.ok(end > start, `<${name}> 调用点未闭合`);
  return SHELL.slice(start, end);
}

test('panel/ 组件声明的关键 prop（t/styles/theme）必须在壳的调用点传参', () => {
  for (const fileName of COMPONENTS) {
    const source = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'panel', fileName), 'utf8');
    const { name, props } = inspectComponent(source, fileName);
    const element = jsxElementInShell(name);
    for (const key of ['t', 'styles', 'theme']) {
      if (!props.has(key)) continue;
      assert.ok(
        element.includes(`${key}={`),
        `<${name}> 声明了 prop「${key}」但调用点未传——渲染体一旦调用它就是 undefined is not a function（2026-10-06 生产白屏根因）`
      );
    }
  }
});

test('ModelParamsModal 渲染体首行就调用 t：回归焦点组件必须显式接 t={t}', () => {
  const source = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'panel', 'ModelParamsModal.js'), 'utf8');
  assert.ok(source.includes("t('localModel.paramsModal.title')"));
  const element = jsxElementInShell('ModelParamsModal');
  assert.ok(element.includes('t={t}'), '壳必须给 ModelParamsModal 传 t={t}');
});
