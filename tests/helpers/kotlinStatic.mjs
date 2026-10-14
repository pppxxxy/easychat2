// Kotlin 静态校验共享工具（无编译器沙箱下的兜底检查）。
//
// 沙箱与 CI 的 JS 测试环境都没有 Kotlin 编译器，原生代码的语法错误只能在
// Gradle 构建阶段才暴露（历史上有过一次编辑遗留重复 `}` 导致 CI 编译失败）。
// 这里把「大括号平衡、字符串/注释剥离、顶层声明唯一、导入与包名一致性、
// 未使用导入」这些纯文本可判定的检查集中实现，供 proactiveMessage 与
// localApiServer 两个插件测试共用，避免同一份逻辑抄两遍后各自漂移。
//
// 这些检查是**兜底**而非编译器替代：只覆盖文本层面可判定的错误。

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// 去掉注释，但保留字符串字面量内容（大括号可能出现在字符串里，
// 后续扫描会单独按字符串规则跳过，这里只需防止注释里的括号干扰计数）。
export function stripComments(source) {
  let out = '';
  let i = 0;
  const length = source.length;
  let inString = false;
  let inTriple = false;
  while (i < length) {
    const ch = source[i];
    if (inTriple) {
      if (source.startsWith('"""', i)) {
        inTriple = false;
        out += '"""';
        i += 3;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i += 1;
      continue;
    }
    if (source.startsWith('"""', i)) {
      inTriple = true;
      out += '"""';
      i += 3;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 大括号平衡：返回 `{ balance, errors }`。errors 记录出现多余 `}` 的位置
// （提前闭合往往意味着编辑留下了重复片段）。
// 字符串（含三引号原始字符串、含转义）与注释内的括号一律忽略。
export function checkBraceBalance(source) {
  const errors = [];
  let balance = 0;
  let line = 1;
  let i = 0;
  const length = source.length;
  let inString = false;
  let inTriple = false;
  while (i < length) {
    const ch = source[i];
    if (ch === '\n') line += 1;
    if (inTriple) {
      if (source.startsWith('"""', i)) {
        inTriple = false;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (source.startsWith('"""', i)) {
      inTriple = true;
      i += 3;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? length : end + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const skipped = source.slice(i, end < 0 ? length : end);
      line += (skipped.match(/\n/g) || []).length;
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (ch === '{') balance += 1;
    else if (ch === '}') {
      balance -= 1;
      if (balance < 0) errors.push({ line, message: '出现多余的 }' });
    }
    i += 1;
  }
  return { balance, errors };
}

// 读取目录下全部 .kt，返回 [{ file, source }]。
export function readKotlinFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.kt'))
    .sort()
    .map(name => ({ file: name, source: readFileSync(path.join(dir, name), 'utf8') }));
}

// 拼接目录下全部 .kt（顶层声明唯一性等需要跨文件判定的检查用）。
export function readAllKotlin(dir) {
  return readKotlinFiles(dir)
    .map(item => item.source)
    .join('\n');
}

// 包名一致性：同一目录下的 .kt 必须声明同一个 package。
export function checkPackageConsistency(dir, expectedPackage) {
  const errors = [];
  for (const { file, source } of readKotlinFiles(dir)) {
    const match = source.match(/^\s*package\s+([\w.]+)\s*$/m);
    if (!match) {
      errors.push({ file, message: '缺少 package 声明' });
      continue;
    }
    if (match[1] !== expectedPackage) {
      errors.push({ file, message: `package 应为 ${expectedPackage}，实际 ${match[1]}` });
    }
  }
  return errors;
}

// 顶层声明唯一：同一目录内，给定的声明关键字各自只应出现一次。
export function checkUniqueDeclarations(source, keywords) {
  const errors = [];
  for (const keyword of keywords) {
    const count = source.split(keyword).length - 1;
    if (count !== 1) {
      errors.push({ message: `${keyword} 应恰好定义一次，实际 ${count}` });
    }
  }
  return errors;
}

// 同一类内不得重复声明**同签名**函数——Kotlin 会直接编译失败（redeclaration）。
//
// 为什么需要这条：大括号平衡只能抓「括号写坏了」，抓不到「同一个函数被写了两遍」。
// 而重复声明在**编辑过程中极容易发生**：改动一个大函数时新写了一份实现，旧的那份
// 忘了删（FIX-4 把采集搬到工作线程时就真的踩到了——bitmapFromCachedFrame 出现了
// 两次，而 braceBalance 依旧平衡、JS 测试也全绿，只有真机编译才会炸）。
// 沙箱没有编译器，所以必须由静态检查顶上。
//
// 判据：`fun <name>(<参数表>)` 的**名字 + 参数表**作为一个签名，出现两次即报错。
//
// ⚠️ 必须比参数表，不能只比名字：Kotlin **允许**重载，而框架里重载很常见
//（M4 实现 TTS 时就遇到 `UtteranceProgressListener.onError(String?)` 与
// `onError(String?, Int)` —— 两个都是必须实现的，只比名字会误报成重复声明，
// 逼人删掉其中一个，反而把能编译的代码改成编译不过的）。
// 早先的版本只比简单名，正是这个误报。
//
// 参数表归一：去掉全部空白后比较。空白在 Kotlin 参数表里不具语义，
// 归一后 `foo(a:Int)` 与 `foo(a: Int)` 视为同一签名（它们是同一个声明）。
// 已知局限（有意的保守方向）：默认值里含空白的字符串理论上可能让两个**不同**
// 签名归一成同一串——那只会漏报，不会误报。漏报的代价远低于误报
//（误报会逼人删掉合法的重载，把好代码改坏）。
//
// 另一处局限：按**文件**粒度而非类粒度。同一文件里两个不同类各有一个同签名
// 私有函数会被误报——本项目原生代码每个文件只有一个主类，故可接受。
export function checkDuplicateFunctions(source) {
  const errors = [];
  const seen = new Map();
  const re = /^[ \t]*(?:@\w+[^\n]*\n[ \t]*)*(?:(?:private|public|internal|protected|override|suspend|inline|operator|open|final|abstract|tailrec|external|lateinit|const)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/gm;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1];
    // 从 `(` 开始取到配对的那个 `)`（参数表里可能有嵌套括号与默认值表达式）。
    const params = readBalancedParens(source, match.index + match[0].length - 1);
    const signature = `${name}(${params.replace(/\s+/g, '')})`;
    const line = source.slice(0, match.index).split('\n').length;
    if (seen.has(signature)) {
      errors.push({
        name,
        line,
        firstLine: seen.get(signature).line,
        message: `函数 ${signature} 在同一个文件里声明了两次（第 ${seen.get(signature).line} 行与第 ${line} 行）——Kotlin 会编译失败`,
      });
    } else {
      seen.set(signature, { line });
    }
  }
  return errors;
}

// 从 `(` 的下标开始，返回配对 `)` 之间的内容（不含两端括号）。
// 需要处理嵌套：`foo(bar(1), baz(2))`。字符串里的括号也跳过，
// 否则 `foo(a: String = ")")` 会被提前截断。
function readBalancedParens(source, openIndex) {
  if (source[openIndex] !== '(') return '';
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return '';
}

// 未使用导入（启发式）：取导入的末段简单名，检查它在**去掉导入行与注释后**的
// 正文里是否出现过。适用于本项目的原生模块（导入都是类型/函数简单名引用）。
//
// 已知局限：仅靠简单名匹配，若同名标识符恰好出现在别处会漏报；对 `as` 别名按
// 别名判定。这是有意的——宁可漏报也不要误报，误报会逼开发者加无意义的引用。
export function findUnusedImports(source) {
  const lines = source.split('\n');
  const importLines = [];
  const bodyLines = [];
  let inBlockComment = false;
  for (const line of lines) {
    if (inBlockComment) {
      bodyLines.push(line);
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      inBlockComment = true;
      bodyLines.push(line);
      continue;
    }
    if (/^\s*import\s+/.test(line)) {
      importLines.push(line);
      continue;
    }
    bodyLines.push(line);
  }
  const body = stripComments(bodyLines.join('\n'));
  const unused = [];
  for (const line of importLines) {
    const match = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/);
    if (!match) continue;
    const name = match[2] || match[1].split('.').pop();
    // 导入末段可能是 `*`，跳过通配导入
    if (name === '*') continue;
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!pattern.test(body)) {
      unused.push({ name, line: line.trim() });
    }
  }
  return unused;
}
