// 世界分组 i18n 批次回归：迁移后的文件不得再有硬编码中文 UI 文案。
//
// 这是本批次最重要的守卫——迁移的意义就是「漏一处等于没迁」：用户切到英文
// 界面后，任何残留的中文字面量都会直接显示出来。三个例外必须显式放行：
// 1) 注释（源码说明，不是 UI 文案）——注意只在字符串外的 `//` 才算注释；
// 2) 导航路由名 '聊天'（导航内部标识符，与 tabBarLabel 分离，按 i18n 既有裁决不译）；
// 3) 发往模型的中文提示词（本批次文件里已无，它们在 src/*/commentPrompts.js）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILES = [
  'src/ExtensionScreen.js',
  'src/music/MusicScreen.js',
  'src/books/BookScreen.js',
  'src/books/BookReaderView.js',
  'src/screenWatch/ScreenWatchScreen.js',
];

const CJK = /[\u4e00-\u9fff]/;

// 去掉行尾注释：只在字符串字面量之外遇到 `//` 才算注释起点。
// （不能用「含 // 就截断」的粗暴做法——URL、正则、'a//b' 里都有 //。）
function stripLineComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
  }
  return line;
}

function readLines(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8').split('\n');
}

test('迁移文件零硬编码中文（注释与路由名除外）', () => {
  const offenders = [];
  FILES.forEach(file => {
    readLines(file).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = stripLineComment(line);
      // 导航路由名：navigate('聊天')——路由标识符不译（既有裁决）
      const withoutRoutes = code.replace(/navigate\('聊天'\)/g, '');
      if (!CJK.test(withoutRoutes)) return;
      offenders.push(`${file}:${index + 1}  ${trimmed.slice(0, 90)}`);
    });
  });
  assert.deepEqual(offenders, [], `仍有硬编码中文 UI 文案：\n${offenders.join('\n')}`);
});

test('迁移文件确实接入 useTranslation', () => {
  FILES.forEach(file => {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(source.includes('useTranslation'), `${file} 未接入 useTranslation`);
    assert.ok(/const \{ t \} = useTranslation\(\)/.test(source), `${file} 未取 t`);
  });
});

test('本批次词条：en 零漏译、零孤儿、无中文字面量', async () => {
  const { en } = await import('../src/i18n/locales/en.js');
  const zhCN = (await import('../src/i18n/locales/zh-CN.js')).zhCN;
  const batchKeys = Object.keys(zhCN).filter(key => /^(ext|music|books|screenWatch)\./.test(key));
  assert.ok(batchKeys.length > 80, `本批次词条数量异常：${batchKeys.length}`);
  const missing = batchKeys.filter(key => typeof en[key] !== 'string' || !en[key]);
  assert.deepEqual(missing, [], `英文缺词条：${missing.join(', ')}`);
  const orphans = Object.keys(en).filter(key => !(key in zhCN));
  assert.deepEqual(orphans, [], `英文孤儿词条：${orphans.join(', ')}`);
  // 英文词条里不得残留中文（复制粘贴漏译的典型形态）
  const cjkInEn = Object.entries(en)
    .filter(([key, value]) => /^(ext|music|books|screenWatch)\./.test(key) && CJK.test(value));
  assert.deepEqual(cjkInEn, [], `英文词条含中文：${cjkInEn.map(([key]) => key).join(', ')}`);
});

test('插值占位符：中英一致（漏参数会让界面露出 {xxx}）', async () => {
  const { en } = await import('../src/i18n/locales/en.js');
  const zhCN = (await import('../src/i18n/locales/zh-CN.js')).zhCN;
  const placeholders = text => (String(text).match(/\{(\w+)\}/g) || []).sort().join(',');
  // 例外：单位换算词条——中文按「万」、英文按「k」计数，占位符天然不同；
  // 调用点必须把两个数值都传（下方单独断言），否则某语言会露出原始占位符。
  const localeSpecific = new Set(['books.list.chars.tenThousand']);
  const mismatched = Object.keys(zhCN)
    .filter(key => /^(ext|music|books|screenWatch)\./.test(key))
    .filter(key => !localeSpecific.has(key))
    .filter(key => placeholders(zhCN[key]) !== placeholders(en[key]))
    .map(key => `${key}: zh[${placeholders(zhCN[key])}] vs en[${placeholders(en[key])}]`);
  assert.deepEqual(mismatched, [], `占位符不一致：\n${mismatched.join('\n')}`);
  const bookScreen = fs.readFileSync(path.resolve('src/books/BookScreen.js'), 'utf8');
  assert.ok(/wan:\s*\(item\.chars \/ 10000\)/.test(bookScreen)
    && /k:\s*Math\.round\(item\.chars \/ 1000\)/.test(bookScreen),
  'books.list.chars.tenThousand 的调用点必须同时传 wan 与 k，否则某语言的占位符不会被替换');
});

test('「角色」兜底走 common.characterFallback，评论落库不再写入默认名', () => {
  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN.js'), 'utf8');
  assert.ok(zh.includes("'common.characterFallback': '角色'"));
  // 三个评论 hook 落库时 characterName 允许为空（显示层补），否则切语言后旧评论不会变
  ['src/music/useMusicComments.js', 'src/books/useBookComments.js', 'src/screenWatch/useScreenWatchComments.js']
    .forEach(file => {
      const source = fs.readFileSync(path.resolve(file), 'utf8');
      assert.ok(source.includes("characterName: String(character.name || '').trim(),"),
        `${file} 落库时不应写死默认角色名`);
    });
});
