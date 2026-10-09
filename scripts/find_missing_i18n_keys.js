// 从代码反推缺失的 i18n 键：扫描 src/ 下所有 t('...')/tActive('...') 直接引用，
// 以及 xxxKey: '域.键' 间接引用（如 SamplingCard 的 labelKey），与语言包对比，
// 输出缺失键及其出现的文件/行号。
// 用于补救改了代码但没写键清单的情况；检测规则与盲区边界见 i18nKeyAudit.mjs。
// 用法：node scripts/find_missing_i18n_keys.js [--json]

import { auditI18nKeys } from './i18nKeyAudit.mjs';

const result = auditI18nKeys();

if (process.argv.includes('--json')) {
  const out = {};
  for (const { key, sites } of result.missing) out[key] = sites;
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`代码引用键总数: ${result.refCount}`);
  console.log(`语言包现有键: ${result.localeCount}`);
  console.log(`缺失键: ${result.missing.length}`);
  console.log('---');
  for (const { key, sites } of result.missing) {
    const locs = sites.map(s => `${s.file}:${s.line}${s.indirect ? '（间接）' : ''}`);
    console.log(`${key}  (${locs.join(', ')})`);
  }
}
