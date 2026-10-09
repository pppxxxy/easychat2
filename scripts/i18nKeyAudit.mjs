// i18n 键对账核心（CLI 薄壳见 find_missing_i18n_keys.js，测试见 tests/i18nKeyAudit.test.mjs）。
//
// 覆盖两类引用：
//  ① 直接：t('字面量') / tActive('字面量')；
//  ② 间接：xxxKey: '字面量'（如 SamplingCard 的 labelKey: 'settings.sampling.maxTokens'）。
//     2026-10-09 实证：e67347e 把四个采样字段标签从硬编码中文换成 labelKey 引用时
//     漏补词条，界面一直显示键名原文（settings.sampling...），旧扫描器只认直接引用，
//     这类问题它天然看不见。
//
// 盲区边界（有意不覆盖，勿当缺陷）：
//  · 不含点的间接值不判定（如 openAssist({ listKey: 'worldInfo' }) 的数据标识）——
//    本仓库 i18n 键全部带域前缀（含点），无点值纳入只会把数据标识误报成缺键；
//  · 行内注释里的引用（只跳过整行注释）；
//  · 其它间接形态（ref.current.key、变量拼接等）不在静态扫描范围内。
import fs from 'node:fs';
import path from 'node:path';

// 递归收集 rootDir/src 下全部 .js/.mjs。
function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function auditI18nKeys(rootDir = path.resolve(import.meta.dirname, '..')) {
  const srcDir = path.join(rootDir, 'src');
  const refs = new Map(); // key -> [{file, line, indirect}]

  const addRef = (key, file, line, indirect) => {
    if (!refs.has(key)) refs.set(key, []);
    refs.get(key).push({ file: path.relative(rootDir, file), line, indirect });
  };

  for (const file of walkFiles(srcDir)) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      // 整行注释跳过：routeNames.js 的注释里就有 t('app.tab.*') 这句说明文字，
      // 旧版把它当引用，长期挂着一条假缺失——假噪音会掩盖真问题。
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const m of line.matchAll(/\bt(?:Active)?\(\s*'([^']+)'/g)) {
        addRef(m[1], file, index + 1, false);
      }
      // 间接引用：xxxKey: '域.键'（value 含点才判定，见文件头盲区边界）。
      for (const m of line.matchAll(/\b[a-zA-Z]+Key:\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        addRef(m[1], file, index + 1, true);
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
  })(path.join(rootDir, 'src', 'i18n', 'locales'));

  const missing = [...refs.keys()]
    .filter(key => !existing.has(key))
    .sort()
    .map(key => ({ key, sites: refs.get(key) }));

  return { refCount: refs.size, localeCount: existing.size, missing };
}
