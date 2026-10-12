// Kotlin 源码静态体检：这里拦的是「JS 侧 lint 与测试都发现不了、只在 CI 打包时才爆」
// 的一类错误——反馈链最长（要等 prebuild + gradle 才看到），值得单独兜住。
//
// 已知案例（打包失败）：
//   OverlayService.setCharacterName 写了 `String(name ?: "").trim()`。
//   Kotlin 的 String **没有**以 String 为参数的构造函数（Java 的 new String(s) 在 Kotlin 里
//   不存在），编译直接报：
//     None of the following candidates is applicable:
//     fun String(bytes: ByteArray) / (chars: CharArray) / (stringBuffer: StringBuffer) / …
//   正确写法就是 `(name ?: "").trim()`。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SEARCH_DIRS = ['plugins'];
// 合法：String(bytes, Charsets.UTF_8) 这类多参数构造；或参数名明确是字符/字节容器。
const SAFE_ARG = /^(bytes|byteArray|chars|charArray|data|buffer|raw)$/;

function listKotlinFiles() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.kt')) out.push(full);
    }
  };
  SEARCH_DIRS.forEach(dir => {
    if (fs.existsSync(dir)) walk(dir);
  });
  return out;
}

test('Kotlin 源码：不得把 String(...) 当字符串转换函数用', () => {
  const files = listKotlinFiles();
  assert.ok(files.length > 0, '必须能找到插件的 Kotlin 源码');

  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const matches = line.match(/(^|[^.\w])String\(([^()]*)\)/g) || [];
      for (const raw of matches) {
        const args = raw.slice(raw.indexOf('(') + 1, -1).trim();
        if (!args) continue;
        if (args.includes(',')) continue;
        if (SAFE_ARG.test(args)) continue;
        offenders.push(`${path.relative('.', file)}:${index + 1}  ${trimmed}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'Kotlin 的 String 没有以 String 为参数的构造函数，下面这些会直接让 compileReleaseKotlin 失败：\n'
      + offenders.join('\n')
  );
});

test('工作区主界面的角色名同步：JS 侧保证非空，Kotlin 侧可空兜底', () => {
  const overlay = fs.readFileSync('src/screenWatch/overlay.js', 'utf8');
  assert.ok(
    /setCharacterName\(String\(name \|\| ''\)\)/.test(overlay),
    'JS 桥侧要把角色名收敛成非空字符串'
  );
  const service = fs.readFileSync('plugins/screenOverlay/android/OverlayService.kt', 'utf8');
  assert.ok(
    /fun setCharacterName\(name: String\?\)/.test(service),
    'service 侧用可空入参，elvis 兜底'
  );
  assert.ok(
    /characterName = \(name \?\: ""\)\.trim\(\)/.test(service),
    '赋值不得再套 String(...)'
  );
});

// 已知案例二（打包失败，2026-10-12）：
//   ScreenOverlayModule 查询无障碍开关时写了
//     TextUtils.SimpleStringSplitter(':').apply { setString(raw) }
//       .asSequence().map { it.trim() }…
//   TextUtils.SimpleStringSplitter **同时**实现 Iterable<String> 与 Iterator<String>，而 Kotlin
//   对这两种接收者都提供 asSequence() 重载 → CI 报：
//     Overload resolution ambiguity between candidates:
//       fun <T> Iterable<T>.asSequence(): Sequence<T>
//       fun <T> Iterator<T>.asSequence(): Sequence<T>
//   接收者类型因此未定，后面 map/any 的 lambda 参数 `it` 也一并变成 Unresolved reference。
//   toList() / any() 只定义在 Iterable 上，没有二义。
//
// 这类错误 JS 侧 lint 与全部单测都看不见，只有 prebuild + gradle 才爆（反馈链最长），
// 所以在这里静态兜住。
test('Kotlin 源码：不得在 SimpleStringSplitter 上调用 asSequence()（Iterable/Iterator 二义）', () => {
  const files = listKotlinFiles();
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '');
    // 同一个表达式里（SimpleStringSplitter 之后 200 字符内）出现 .asSequence() 即视为二义
    const pattern = /SimpleStringSplitter[\s\S]{0,200}?\.asSequence\s*\(/g;
    let match;
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative('.', file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'SimpleStringSplitter 同时是 Iterable 与 Iterator，asSequence() 会二义、compileReleaseKotlin 失败；'
      + '请改用 .toList()（或直接 .any { … }）：\n' + offenders.join('\n')
  );
});
