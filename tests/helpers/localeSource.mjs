// 快赢3 后语言包按域拆分（locales/<语言>/<域>.js + 聚合入口）。「键存在于语言包
// 文本」类断言统一经此取文本：递归拼接目录下全部 .js（聚合入口无键行，拼入无害）。
import fs from 'node:fs';
import path from 'node:path';

export function localeSource(dirRelative) {
  let out = '';
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out += fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.resolve(dirRelative));
  return out;
}
