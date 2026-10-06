// 扫描 UI 硬编码中文：排除注释行、i18n 目录、games/html 后，匹配六类模式。
// 用法：node scripts/scan_ui_chinese.js [--json]
// 判定标准见任务书 §5.1。输出按文件分组的命中行，供 A 类修复对照与验收清零。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INCLUDE_DIR = path.join(ROOT, 'src');
const EXCLUDE_PARTS = ['i18n', 'games' + path.sep + 'html'];

const PATTERNS = [
  { name: 'alert', re: /Alert\.alert\([^)]*[\u4e00-\u9fff]/ },
  { name: 'placeholder', re: /placeholder\s*=\s*['"`][^'"`]*[\u4e00-\u9fff]/ },
  { name: 'a11y', re: /accessibilityLabel\s*=\s*['"`][^'"`]*[\u4e00-\u9fff]/ },
  { name: 'jsxText', re: />[^<>{}\n]*[\u4e00-\u9fff][^<>\n]*</ },
  { name: 'labelProp', re: /(title|label)\s*=\s*['"`][^'"`]*[\u4e00-\u9fff]/ },
  { name: 'throw', re: /throw new Error\(['"`][^'"`]*[\u4e00-\u9fff]/ },
];

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_PARTS.some(part => full.includes(part))) continue;
      walk(full, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const hits = [];
for (const file of walk(INCLUDE_DIR)) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ file: rel, line: i + 1, kind: p.name, text: line.trim().slice(0, 120) });
        break;
      }
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(hits, null, 2));
} else {
  const byFile = new Map();
  for (const hit of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push(hit);
  }
  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [file, list] of sorted) {
    console.log(`${file}  (${list.length})`);
  }
  console.log('---');
  console.log(`文件 ${byFile.size} 个，命中 ${hits.length} 行`);
}
