// 章节渲染组件的源码断言（ChapterNotice / ChapterOutro 是同形代码，2026-10 同批修；
// 另含 ChapterImages 的守卫形状，以及两处链接行的口径一致性）：
// - 外链打不开必须提示：以前两处都是 `Linking.openURL(url).catch(() => {})`，点「继续打开」
//   后毫无反应，用户以为链接失效（同仓 chat/RichHtmlMessage.js 早已弹 Alert）；
// - accessibilityLabel 必须走 t()：以前是模板串硬编码中文（`打开 ${...}`），英文界面下
//   TalkBack/VoiceOver 会朗读中文。eslint-rules/no-hardcoded-chinese.mjs 的文件头自己写明
//   「模板串里的中文仍不覆盖……只能靠 review」，所以这条只能由源码断言兜住。
//
// 注释里会引用旧写法说明「为什么改」，所以先剥注释再断言（与 booksComments.test.mjs 同一机制）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localeSource } from './helpers/localeSource.mjs';

const FILES = ['src/books/ChapterNotice.js', 'src/books/ChapterOutro.js'];

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('外链打开失败必须提示，不得静默吞掉', () => {
  for (const file of FILES) {
    const code = stripComments(readSource(file));
    assert.equal(/\.catch\(\(\) => \{\}\)/.test(code), false,
      `${file}：不得再有空的 .catch(() => {})`);
    assert.ok(
      /Linking\.openURL\(url\)\.catch\(\(\) => \{\s*Alert\.alert\(/.test(code),
      `${file}：Linking 失败必须弹 Alert（对照 chat/RichHtmlMessage.js 的 handleCardLink）`,
    );
    assert.ok(
      code.includes("t('books.notice.openFailed.title')") && code.includes("t('books.notice.openFailed.body')"),
      `${file}：失败提示走文案键，不渲染原始报错`,
    );
  }
});

test('外链 accessibilityLabel 必须走 t()，不得硬编码中文', () => {
  for (const file of FILES) {
    const code = stripComments(readSource(file));
    assert.ok(
      /accessibilityLabel=\{t\('books\.notice\.openLinkA11y',\s*\{\s*name:/.test(code),
      `${file}：无障碍标签必须走 t() 并带 {name} 参数`,
    );
    assert.equal(
      /accessibilityLabel=\{`[^`]*[\u3400-\u4dbf\u4e00-\u9fff]/.test(code),
      false,
      `${file}：不得再用含中文的模板串作无障碍标签`,
    );
  }
});

test('外链与坏 docx 的新增词条中英齐备', () => {
  const keys = [
    'books.notice.openFailed.title',
    'books.notice.openFailed.body',
    'books.notice.openLinkA11y',
    'books.import.docxInvalid.title',
    'books.import.docxInvalid.body',
    'books.import.docxNoBody.title',
    'books.import.docxNoBody.body',
  ];
  for (const locale of ['zh-CN', 'en']) {
    const table = localeSource(`src/i18n/locales/${locale}`);
    for (const key of keys) {
      assert.ok(table.includes(`'${key}'`), `${locale} 缺少文案键 ${key}`);
    }
  }
});

test('BookScreen 按 code 分流坏 docx（不落到泛化/不支持提示）', () => {
  const handler = (() => {
    const screen = readSource('src/books/BookScreen.js');
    return screen.slice(screen.indexOf('const handleImport'), screen.indexOf('const handleOpen'));
  })();
  assert.ok(handler.length > 0, '必须能定位到 handleImport 处理体');
  for (const [code, key] of [
    ['DOCX_INVALID', 'books.import.docxInvalid'],
    ['DOCX_NO_BODY', 'books.import.docxNoBody'],
  ]) {
    assert.ok(handler.includes(`code === '${code}'`), `handleImport 必须有 ${code} 独立分支`);
    assert.ok(handler.includes(`t('${key}.title')`) && handler.includes(`t('${key}.body')`),
      `${code} 分支必须用 ${key}.* 文案键`);
  }
});

// ---- 链接行 label 缺失时的回退（ChapterNotice / ChapterOutro 是平行定义）----
//
// 两个组件的链接行是逐字几乎相同的两份手写实现（openLink / linkRow / linkLabel 样式），
// 但 label 缺失时行为不一致：ChapterOutro 渲染 `link.label || link.url`，ChapterNotice 只渲染
// `link.label` ⇒ 留下**一行空白**（看着像坏掉的按钮），而 ChapterNotice 自己上面的 Alert 标题
// 早已是 `|| link.url` 口径——同一个组件里两种口径。
// 当前不可达（onboardingContent.js 的 links 都带 label），属「守卫/回退写了但不齐」。
// 注：不抽共享组件——两个文件刚被同批改过（Alert + a11y），抽组件会扩大改动面；此处只报告平行定义。
test('链接行 label 缺失时回退到 url，不得渲染空白行', () => {
  for (const file of FILES) {
    const code = stripComments(readSource(file));
    assert.ok(
      /<Text style=\{styles\.linkLabel\}[^>]*>\{link\.label \|\| link\.url\}<\/Text>/.test(code),
      `${file}：链接行文案必须回退到 link.url（对照另一处的同款写法）`,
    );
  }
});

// ---- ChapterImages：守卫必须在 hooks 之前归一 ----
//
// 原来写的是 `if (!images || images.length === 0) return null;`，声称容忍 falsy；但上面
// useEffect 的依赖数组 `[images.length, images[0] && images[0].source]` 在**渲染阶段**求值，
// images=null 时先 `null.length` 抛 TypeError ⇒ 那行守卫永远救不了（守卫写了但形状不对）。
// 对照 ChapterSections.js:11 / ChapterNotice.js:14 都用 Array.isArray 兜底，写法更稳。
// 当前不可达（ChapterModal.js / OnboardingModal.js 都传数组），所以用源码级断言钉住形状。
test('ChapterImages 在 hooks 之前把 images 归一为数组', () => {
  const code = stripComments(readSource('src/books/ChapterImages.js'));
  const normalizeAt = code.indexOf('const list = Array.isArray(images) ? images : [];');
  const firstHookAt = code.indexOf('useEffect(');
  assert.ok(normalizeAt >= 0, '必须有 Array.isArray 归一');
  assert.ok(firstHookAt > 0, '前提：能找到第一个 useEffect');
  assert.ok(normalizeAt < firstHookAt, '归一必须在 hooks 之前（否则依赖数组先 null.length 抛错）');
  // 归一之后不得再有裸的 images.* 取值（否则等于没归一）。
  const after = code.slice(normalizeAt);
  assert.equal(/images\.(length|map|\[)/.test(after), false,
    '归一之后不得再直接取 images.length / images.map / images[..]');
  assert.ok(after.includes('list.length'), '后续一律用归一后的 list');
  // 依赖数组必须用 list（不是 images）。
  assert.ok(
    code.includes('}, [list.length, list[0] && list[0].source]);'),
    'useEffect 依赖数组必须用 list.length / list[0]',
  );
});
