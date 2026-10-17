// 具名导入健全性守卫：全仓库扫描「import { X } from './y.js'」是否真的被 y.js 导出。
//
// 为什么需要：Metro/Babel 对不存在的具名导入**不报错**，绑定值为 undefined——
// lint、单测、expo export 全都拦不住，直到运行时按用途炸开：
//   - 组件场景："Element type is invalid ... got: undefined"（z1005z2 前生产包
//     BookScreen→BookReaderView 即此坑：打开任何一本书必崩，与 txt/docx 无关）；
//   - 函数场景：调用时 TypeError: X is not a function（ProactivePanel 的
//     normalizeProtocol 曾从 proactiveRequest 导入，而它定义在 apiProtocols）。
// 两个真实案例都在 main 的生产包里存在过，故此守卫必须全绿才能合并。
//
// 实现：@babel/parser（jsx 插件）走 AST，不做字符串猜测；处理 as 别名、
// export * 递归转发、解构导出；只查本地相对 .js 导入（包导入交给运行时语义）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');

const rootDir = path.resolve('.');

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const scanFiles = [...listJsFiles(path.resolve('src')), path.resolve('App.js')];

const astCache = new Map();
function parseFile(file) {
  if (!astCache.has(file)) {
    const code = fs.readFileSync(file, 'utf8');
    astCache.set(file, parser.parse(code, { sourceType: 'module', plugins: ['jsx'] }).program);
  }
  return astCache.get(file);
}

function patternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') out.add(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach(p => patternNames(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (node.type === 'ArrayPattern') node.elements.forEach(e => patternNames(e, out));
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let target = path.resolve(path.dirname(fromFile), spec);
  if (!target.endsWith('.js') && fs.existsSync(`${target}.js`)) target = `${target}.js`;
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

function collectExports(file, seen = new Set()) {
  const names = new Set();
  if (seen.has(file)) return names;
  seen.add(file);
  for (const node of parseFile(file).body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const d = node.declaration;
        if (d.id && d.id.name) names.add(d.id.name);
        if (Array.isArray(d.declarations)) d.declarations.forEach(decl => patternNames(decl.id, names));
      }
      for (const s of node.specifiers || []) names.add(s.exported.name || s.exported.value);
    } else if (node.type === 'ExportDefaultDeclaration') {
      names.add('default');
    } else if (node.type === 'ExportAllDeclaration' && !node.exported) {
      // export * from './x.js'：递归展开全部被转发的具名导出
      const target = resolveLocal(file, node.source.value);
      if (target) for (const n of collectExports(target, seen)) names.add(n);
    }
  }
  return names;
}

test('具名导入健全性：每个本地具名导入都必须真实存在于目标模块的导出', () => {
  const violations = [];
  for (const file of scanFiles) {
    if (!fs.existsSync(file)) continue;
    let ast;
    try {
      ast = parseFile(file);
    } catch (error) {
      violations.push(`${path.relative(rootDir, file)}: 解析失败 ${error.message}`);
      continue;
    }
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const spec = node.source.value;
      if (!spec.startsWith('.')) continue; // 包导入不在此守卫范围
      const target = resolveLocal(file, spec);
      if (!target) {
        violations.push(`${path.relative(rootDir, file)}: 本地导入解析不到目标 ${spec}`);
        continue;
      }
      const exports = collectExports(target);
      for (const s of node.specifiers) {
        if (s.type !== 'ImportSpecifier') continue; // default / namespace 导入不查
        const imported = s.imported.name || s.imported.value;
        if (!exports.has(imported)) {
          violations.push(
            `${path.relative(rootDir, file)}: 从 ${spec} 具名导入 { ${imported} }，`
            + `但目标导出只有 [${[...exports].sort().join(', ')}]`
          );
        }
      }
    }
  }
  assert.deepEqual(violations, [], `存在具名导入错配（运行时才炸的 undefined）:\n${violations.join('\n')}`);
});

// 上面的用例只查「import 侧」。这留下一个同源盲区：**re-export 侧**。
// `export { X } from './y.js'` 里的 X 若 y.js 根本没导出，ESM 在**链接期**就抛
// SyntaxError（比 import 侧的 undefined 更狠：整个模块图加载失败）。
// 而 Metro/Babel/expo export 都不报错，lint 也不查——正是本波次实测撞到的那一类：
// src/storage/settings/index.js 转发 DEFAULT_DESCRIPTION_PROMPT，而 imageRecognition.js
// 当时声明为 `const`（非 export），于是**任何 import 设置存储的路径都会整链炸掉**。
// 这个 bug 一直躺在主干上没人发现，原因就是没有这条断言。
test('re-export 健全性：每个「export { X } from 本地」的 X 都必须在目标模块真实导出', () => {
  const violations = [];
  for (const file of scanFiles) {
    if (!fs.existsSync(file)) continue;
    let ast;
    try {
      ast = parseFile(file);
    } catch {
      continue; // 解析失败已由上一个用例报出，这里不重复
    }
    for (const node of ast.body) {
      // 只查带 source 的具名转发：export { A, B as C } from './x.js'
      if (node.type !== 'ExportNamedDeclaration' || !node.source) continue;
      const spec = node.source.value;
      if (!spec.startsWith('.')) continue;
      const target = resolveLocal(file, spec);
      if (!target) {
        violations.push(`${path.relative(rootDir, file)}: 转发的目标解析不到 ${spec}`);
        continue;
      }
      const exports = collectExports(target);
      for (const s of node.specifiers) {
        // ExportSpecifier 的 local 是目标模块里的名字（`A as B` 时 local=A, exported=B）
        const source = (s.local && (s.local.name || s.local.value)) || (s.exported && s.exported.name);
        if (!source) continue;
        // `export * as ns from './x.js'` 走 ExportNamespaceSpecifier：它是整体再导出，不查名字
        if (s.type === 'ExportNamespaceSpecifier') continue;
        if (!exports.has(source)) {
          violations.push(
            `${path.relative(rootDir, file)}: 转发 ${spec} 的 { ${source} }，`
            + `但目标导出只有 [${[...exports].sort().join(', ')}]`
          );
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `存在 re-export 错配（ESM 链接期 SyntaxError，整条模块链加载失败）:\n${violations.join('\n')}`
  );
});
