// 从代码反推缺失的 i18n 键：扫描 src/ 下所有 t('...')/tActive('...') 引用，
// 与语言包对比，输出缺失键及其出现的文件/行号。
// 用于补救子代理改了代码但没写键清单的情况。
// 用法：node scripts/find_missing_i18n_keys.js [--json]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const refs = new Map(); // key -> [{file, line}]
for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\bt(?:Active)?\(\s*'([^']+)'/g)) {
      const key = m[1];
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push({ file: path.relative(ROOT, file), line: i + 1 });
    }
  });
}

// 快赢3 后语言包按域拆分（locales/<语言>/<域>.js）：递归收集全部 .js 的键
// （聚合入口无键行，拼入无害）。键匹配须转义感知且不锚定行首——历史文件里
// 存在「一行双键」（如 zh-CN backup 域），只认行首会漏计第二个键。
const existing = new Set();
(function collectLocaleKeys(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectLocaleKeys(full);
    else if (entry.name.endsWith('.js')) {
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/'((?:[^'\\]|\\.)+)'\s*:/g)) {
        existing.add(m[1]);
      }
    }
  }
})(path.join(ROOT, 'src', 'i18n', 'locales'));
const missing = [...refs.keys()].filter(k => !existing.has(k)).sort();

if (process.argv.includes('--json')) {
  const out = {};
  for (const k of missing) out[k] = refs.get(k);
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`代码引用键总数: ${refs.size}`);
  console.log(`语言包现有键: ${existing.size}`);
  console.log(`缺失键: ${missing.length}`);
  console.log('---');
  for (const k of missing) {
    const locs = refs.get(k);
    console.log(`${k}  (${locs.map(l => `${l.file}:${l.line}`).join(', ')})`);
  }
}
