// 把 i18n-keys/*.json 合并进 src/i18n/locales/（快赢3 后按域拆分：词条落在
// zh-CN/<域>.js 与 en/<域>.js，键首段 = 域名）。
// 用法：node scripts/merge_i18n_keys.js [--dir <键清单目录>] [--dry]
// 规则：键已存在则跳过（不覆盖现有翻译）；两包同步写入；全新域自动建域文件
//       并在聚合入口按字母序补展开行；保持文件原有格式风格。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEYS_DIR = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : 'D:\\命令提示符\\.easychat2-test\\i18n-keys';
const DRY = process.argv.includes('--dry');

const LOCALES_DIR = path.join(ROOT, 'src', 'i18n', 'locales');
const AGGREGATORS = {
  zh: { file: path.join(LOCALES_DIR, 'zh-CN.js'), dirName: 'zh-CN', lang: 'zh-CN 基准' },
  en: { file: path.join(LOCALES_DIR, 'en.js'), dirName: 'en', lang: 'English' },
};

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

// 收集某语言包现有键（递归该语言目录下全部 .js；聚合入口无键行，天然无害）。
// 键匹配须转义感知且不锚定行首——历史文件里存在「一行双键」（如 zh-CN backup
// 域），只认行首会漏计第二个键，导致把已存在键当新键重复写入。
function collectExisting(meta) {
  const found = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/'((?:[^'\\]|\\.)+)'\s*:/g)) {
          found.add(m[1]);
        }
      }
    }
  })(path.join(LOCALES_DIR, meta.dirName));
  return found;
}

// 聚合入口补一行展开（按域名字母序插入既有 ...<域>, 行之间）。
function addSpreadLine(meta, domain) {
  const agg = fs.readFileSync(meta.file, 'utf8');
  const tailIdx = agg.lastIndexOf('};');
  if (tailIdx < 0) throw new Error(`${meta.file}: 找不到导出对象结尾`);
  const headLines = agg.slice(0, tailIdx).split('\n');
  let insertAt = headLines.findIndex(l => {
    const m = /^  \.\.\.([A-Za-z0-9]+),\s*$/.exec(l);
    return m && m[1] > domain;
  });
  if (insertAt < 0) {
    insertAt = 0;
    for (let i = 0; i < headLines.length; i += 1) {
      if (/^  \.\.\./.test(headLines[i])) insertAt = i + 1;
    }
  }
  headLines.splice(insertAt, 0, `  ...${domain},`);
  fs.writeFileSync(meta.file, headLines.join('\n') + agg.slice(tailIdx), 'utf8');
}

// 把一批词条行写入对应域文件；全新域先建文件再补聚合入口展开行。
function insertIntoDomainFile(locale, entries, batchBanner) {
  const meta = AGGREGATORS[locale];
  const byDomain = new Map();
  for (const [key, line] of entries) {
    const domain = key.split('.')[0];
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(domain)) {
      throw new Error(`键 "${key}" 首段 "${domain}" 不是合法域标识符`);
    }
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(line);
  }
  for (const [domain, lines] of byDomain) {
    const domainFile = path.join(LOCALES_DIR, meta.dirName, `${domain}.js`);
    if (fs.existsSync(domainFile)) {
      const src = fs.readFileSync(domainFile, 'utf8');
      const tailIdx = src.lastIndexOf('};');
      if (tailIdx < 0) throw new Error(`${domainFile}: 找不到导出对象结尾`);
      const block = `\n  // ---- ${batchBanner} ----\n${lines.join('\n')}\n`;
      fs.writeFileSync(domainFile, src.slice(0, tailIdx) + block + src.slice(tailIdx), 'utf8');
    } else {
      fs.writeFileSync(
        domainFile,
        [
          `// i18n 词条 · ${domain} 域（${meta.lang}）。聚合入口见 ../${meta.dirName}.js。`,
          `export const ${domain} = {`,
          `  // ---- ${batchBanner} ----`,
          ...lines,
          '};',
          '',
        ].join('\n'),
        'utf8'
      );
      addSpreadLine(meta, domain);
      console.log(`  新建域文件: ${meta.dirName}/${domain}.js（聚合入口已补展开行）`);
    }
  }
}

const keys = loadKeys(KEYS_DIR);
console.log(`共 ${keys.size} 个待合并键`);

for (const locale of ['zh', 'en']) {
  const existing = collectExisting(AGGREGATORS[locale]);
  const toAdd = [...keys.entries()].filter(([k]) => !existing.has(k));
  const skip = keys.size - toAdd.length;
  console.log(`${locale}: 已有 ${existing.size} 键，新增 ${toAdd.length}，跳过已存在 ${skip}`);

  if (DRY || toAdd.length === 0) continue;

  const batchBanner = `i18n 迁移批次：硬编码中文清理（${new Date().toISOString().slice(0, 10)}）`;
  const entries = toAdd.map(([key, val]) => [
    key,
    `  '${escapeSingle(key)}': '${escapeSingle(locale === 'zh' ? val.zh : val.en)}',`,
  ]);
  insertIntoDomainFile(locale, entries, batchBanner);
}

if (!DRY) {
  console.log('写入完成。验证键一致性：');
  const zk = collectExisting(AGGREGATORS.zh);
  const ek = collectExisting(AGGREGATORS.en);
  const diff = [...zk].filter(k => !ek.has(k)).concat([...ek].filter(k => !zk.has(k)));
  console.log(`zh-CN: ${zk.size} 键, en: ${ek.size} 键, 一致: ${diff.length === 0}`);
  if (diff.length) console.log('不一致键:', diff.slice(0, 10).join(', '));
}
