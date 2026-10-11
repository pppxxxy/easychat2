// 轻量代码结构提取（LSP-lite，差距 #1 的可行切面）：列出源码里的顶层符号与行号，
// 供 agent 在大文件里快速定位。纯正则启发式——**不追求完备**（真正的 LSP 需要语言服务器，
// 移动端不现实）；覆盖 JS/TS 与 Python 的常见顶层形态。

export function languageFromPath(filePath) {
  const p = String(filePath || '').toLowerCase();
  if (p.endsWith('.ts') || p.endsWith('.tsx')) return 'ts';
  if (p.endsWith('.js') || p.endsWith('.jsx') || p.endsWith('.mjs') || p.endsWith('.cjs')) return 'js';
  if (p.endsWith('.py')) return 'py';
  return '';
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

// 返回 [{ kind, name, line }]（line 从 1 计）。未知语言 → []。
export function extractSymbols(text, language) {
  const patterns = language === 'py'
    ? PY_PATTERNS
    : (language === 'js' || language === 'ts' ? JS_PATTERNS : []);
  if (!patterns.length) return [];
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, re } of patterns) {
      const match = re.exec(lines[i]);
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
