// 轻量代码结构提取（LSP-lite，差距 #1 的可行切面）：列出源码里的顶层符号与行号，
// 供 agent 在大文件里快速定位。纯正则启发式——**不追求完备**（真正的 LSP 需要语言服务器，
// 移动端不现实）；覆盖主流语言的常见顶层形态。
//
// 2026-10-11 扩展：从 JS/TS/Python 扩到 Go / Rust / Java / Kotlin / Ruby / PHP / C/C++ /
// C# / Swift / Shell——「环境深度」在移动端能落地的切面就是代码理解深度（真 LSP 不可行）。

export const SYMBOL_LANGUAGES = Object.freeze([
  'js', 'ts', 'py', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'c', 'cs', 'swift', 'sh',
]);

const EXT_TO_LANG = Object.freeze({
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c',
  cs: 'cs',
  swift: 'swift',
  sh: 'sh', bash: 'sh', zsh: 'sh',
});

export function languageFromPath(filePath) {
  const p = String(filePath || '').toLowerCase();
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return EXT_TO_LANG[p.slice(dot + 1)] || '';
}

export function isSymbolLanguage(language) {
  return SYMBOL_LANGUAGES.includes(String(language || ''));
}

const JS_PATTERNS = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/ },
];

const PY_PATTERNS = [
  { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
];

const GO_PATTERNS = [
  { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
];

const RUST_PATTERNS = [
  { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ },
  { kind: 'type', re: /^\s*(?:pub\s+)?(?:type|mod)\s+([A-Za-z_]\w*)/ },
];

const JAVA_PATTERNS = [
  { kind: 'class', re: /^\s*(?:public\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/ },
];

const KOTLIN_PATTERNS = [
  { kind: 'function', re: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|suspend\s+|inline\s+|override\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|abstract\s+|sealed\s+|data\s+|enum\s+|annotation\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/ },
];

const RUBY_PATTERNS = [
  { kind: 'function', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: 'module', re: /^\s*module\s+([A-Za-z_]\w*)/ },
];

const PHP_PATTERNS = [
  { kind: 'function', re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*function\s+([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*(?:final\s+|abstract\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/ },
];

const C_PATTERNS = [
  { kind: 'class', re: /^\s*(?:typedef\s+)?(?:struct|class|union|enum)\s+([A-Za-z_]\w*)/ },
  { kind: 'type', re: /^\s*typedef\b[^;]*?\b([A-Za-z_]\w*)\s*;/ },
  // 函数定义启发式：一行以「返回类型 名字(」开头且以 { 结尾（排除控制流关键字）。
  { kind: 'function', re: /^\s*(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+)*[A-Za-z_][\w:*&<>\s]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/ },
];

const CS_PATTERNS = [
  { kind: 'class', re: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|sealed\s+|abstract\s+|static\s+|partial\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/ },
];

const SWIFT_PATTERNS = [
  { kind: 'function', re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|static\s+|class\s+|override\s+|mutating\s+)*func\s+([A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/ },
];

const SH_PATTERNS = [
  { kind: 'function', re: /^\s*function\s+([A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*([A-Za-z_]\w*)\s*\(\s*\)\s*\{/ },
];

const PATTERNS_BY_LANGUAGE = Object.freeze({
  js: JS_PATTERNS,
  ts: JS_PATTERNS,
  py: PY_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  kotlin: KOTLIN_PATTERNS,
  ruby: RUBY_PATTERNS,
  php: PHP_PATTERNS,
  c: C_PATTERNS,
  cs: CS_PATTERNS,
  swift: SWIFT_PATTERNS,
  sh: SH_PATTERNS,
});

// 返回 [{ kind, name, line }]（line 从 1 计）。未知语言 → []。
export function extractSymbols(text, language) {
  const patterns = PATTERNS_BY_LANGUAGE[String(language || '')] || [];
  if (!patterns.length) return [];
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { kind, re } of patterns) {
      const match = re.exec(line);
      if (match) {
        out.push({ kind, name: match[1], line: i + 1 });
        break; // 一行只认一个符号（避免同一行同时命中 class/function）
      }
    }
  }
  return out;
}

export function formatSymbols(symbols, filePath = '') {
  const list = Array.isArray(symbols) ? symbols : [];
  if (!list.length) return `（${filePath || '文件'} 未提取到顶层符号，或语言不支持）`;
  return list.map(item => `${item.line}: ${item.kind} ${item.name}`).join('\n');
}
