// 把 i18n-keys/*.json 合并进 src/i18n/locales/zh-CN.js 与 en.js。
// 用法：node scripts/merge_i18n_keys.js [--dir <键清单目录>] [--dry]
// 规则：键已存在则跳过（不覆盖现有翻译）；两包同步写入；保持文件原有格式风格。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEYS_DIR = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : 'D:\\命令提示符\\.easychat2-test\\i18n-keys';
const DRY = process.argv.includes('--dry');

const zhPath = path.join(ROOT, 'src/i18n/locales/zh-CN.js');
const enPath = path.join(ROOT, 'src/i18n/locales/en.js');

function loadKeys(dir) {
  const merged = new Map();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [key, val] of Object.entries(obj)) {
      if (merged.has(key)) {
        console.warn(`⚠️ 键冲突: ${key}（${f} 覆盖之前的）`);
      }
      merged.set(key, { zh: String(val.zh || ''), en: String(val.en || ''), from: f });
    }
  }
  return merged;
}

function escapeSingle(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function insertKeys(filePath, locale) {
  const src = fs.readFileSync(filePath, 'utf8');
  // 找最后一个 ' 键: '值', 的位置（在 export 对象的尾部）
  const tail = src.lastIndexOf('};');
  if (tail < 0) throw new Error('找不到语言包结尾');
  return { src, tail };
}

const keys = loadKeys(KEYS_DIR);
console.log(`共 ${keys.size} 个待合并键`);

for (const [filePath, locale] of [[zhPath, 'zh'], [enPath, 'en']]) {
  const { src, tail } = insertKeys(filePath, locale);
  const existing = new Set();
  for (const m of src.matchAll(/^\s*'([^']+)':/gm)) existing.add(m[1]);
  const toAdd = [...keys.entries()].filter(([k]) => !existing.has(k));
  const skip = keys.size - toAdd.length;
  console.log(`${locale}: 已有 ${existing.size} 键，新增 ${toAdd.length}，跳过已存在 ${skip}`);

  if (DRY) continue;

  const lines = toAdd.map(([key, val]) => `  '${escapeSingle(key)}': '${escapeSingle(locale === 'zh' ? val.zh : val.en)}',`);
  if (lines.length === 0) continue;
  // 在 '};' 前插入，前面加一行分组注释
  const block = `\n  // ---- i18n 迁移批次：硬编码中文清理（${new Date().toISOString().slice(0, 10)}）----\n${lines.join('\n')}\n`;
  const next = src.slice(0, tail) + block + src.slice(tail);
  fs.writeFileSync(filePath, next, 'utf8');
}

if (!DRY) {
  console.log('写入完成。验证键一致性：');
  // 用文件读取而非 import，避免 Windows 路径协议问题
  const zhSrc = fs.readFileSync(zhPath, 'utf8');
  const enSrc = fs.readFileSync(enPath, 'utf8');
  const zk = new Set();
  for (const m of zhSrc.matchAll(/^\s*'([^']+)':/gm)) zk.add(m[1]);
  const ek = new Set();
  for (const m of enSrc.matchAll(/^\s*'([^']+)':/gm)) ek.add(m[1]);
  const diff = [...zk].filter(k => !ek.has(k)).concat([...ek].filter(k => !zk.has(k)));
  console.log(`zh-CN: ${zk.size} 键, en: ${ek.size} 键, 一致: ${diff.length === 0}`);
  if (diff.length) console.log('不一致键:', diff.slice(0, 10).join(', '));
}
