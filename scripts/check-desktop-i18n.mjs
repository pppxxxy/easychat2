// 校验桌面源码里出现的 t('key') 词条是否都存在于 zh-CN 与 en 两个 locale。
//
// 为什么需要：桌面有大量手写 JSX，词条名写错（如 schedule.role 实际叫
// schedule.selectRole）在运行时只会显示成 key 本身——界面看起来「没翻译」，
// 但 lint 抓不到（t() 是函数调用，不是字面量约束）。这个脚本把这类错误前移到
// 构建前，并同时检查英文侧（漏翻一条就会在英文界面里露出中文 key）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'desktop', 'src');

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, out);
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

function flatten(object, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(object || {})) {
    if (value && typeof value === 'object') flatten(value, `${prefix}${key}.`, out);
    else out.set(`${prefix}${key}`, value);
  }
  return out;
}

const zh = flatten((await import(pathToFileURL(path.join(ROOT, 'src', 'i18n', 'locales', 'zh-CN.js')).href)).default);
const en = flatten((await import(pathToFileURL(path.join(ROOT, 'src', 'i18n', 'locales', 'en.js')).href)).default);

// 只收集**字面量** t('...')：模板串（t(`x.${y}`)）无法静态判定，跳过。
const KEY_RE = /\bt(?:Active)?\(\s*'([a-zA-Z0-9_.]+)'/g;
// 动态拼接的前缀（如 t(`schedule.dayKind.${kind}`)）只能按前缀白名单放过。
const DYNAMIC_PREFIX_RE = /\bt\(\s*`([a-zA-Z0-9_.]+)\$\{/g;

const missingZh = new Map();
const missingEn = new Map();
let checked = 0;
for (const file of collectFiles(DESKTOP)) {
  const source = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  for (const match of source.matchAll(KEY_RE)) {
    const key = match[1];
    checked += 1;
    if (!zh.has(key)) missingZh.set(key, rel);
    else if (!en.has(key)) missingEn.set(key, rel);
  }
  // 动态键：断言前缀在两种语言里都至少有一条，否则整族缺失。
  for (const match of source.matchAll(DYNAMIC_PREFIX_RE)) {
    const prefix = match[1];
    const hasZh = [...zh.keys()].some(key => key.startsWith(prefix));
    const hasEn = [...en.keys()].some(key => key.startsWith(prefix));
    if (!hasZh) missingZh.set(`${prefix}*`, rel);
    else if (!hasEn) missingEn.set(`${prefix}*`, rel);
  }
}

if (missingZh.size > 0 || missingEn.size > 0) {
  for (const [key, file] of missingZh) console.error(`[i18n:desktop] zh-CN 缺词条 ${key}（用于 ${file}）`);
  for (const [key, file] of missingEn) console.error(`[i18n:desktop] en 缺词条 ${key}（用于 ${file}）`);
  process.exit(1);
}
console.log(`[i18n:desktop] ok：${checked} 处字面量词条在 zh-CN / en 双端都存在。`);