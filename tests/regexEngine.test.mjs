import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REGEX_PLACEMENT,
  applyRegexScripts,
  compileRegex,
  compileRegexCached,
  isUnsafeRegexPattern,
} from '../src/prompt/regexEngine.js';
import { character as zhCharacter } from '../src/i18n/locales/zh-CN/character.js';
import { forge as zhForge } from '../src/i18n/locales/zh-CN/forge.js';
import { character as enCharacter } from '../src/i18n/locales/en/character.js';
import { forge as enForge } from '../src/i18n/locales/en/forge.js';

const script = (patch = {}) => ({
  enabled: true,
  placement: [REGEX_PLACEMENT.AI_OUTPUT],
  findRegex: '/foo/g',
  replaceString: 'bar',
  ...patch,
});

test('没有脚本时原样返回（且不做任何处理）', () => {
  assert.equal(applyRegexScripts('foo foo', [], REGEX_PLACEMENT.AI_OUTPUT), 'foo foo');
  assert.equal(applyRegexScripts('foo foo', null, REGEX_PLACEMENT.AI_OUTPUT), 'foo foo');
});

test('按 placement 过滤脚本', () => {
  const scripts = [script({ placement: [REGEX_PLACEMENT.USER_INPUT] })];
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.AI_OUTPUT), 'foo');
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.USER_INPUT), 'bar');
});

test('非法正则被跳过，不影响其它脚本', () => {
  const scripts = [
    script({ findRegex: '/(/g' }),
    script({ findRegex: '/foo/g', replaceString: 'ok' }),
  ];
  assert.equal(applyRegexScripts('foo', scripts, REGEX_PLACEMENT.AI_OUTPUT), 'ok');
});

test('缓存的正则复用时不残留 lastIndex（连续 replace 结果一致）', () => {
  const first = applyRegexScripts('a b c', [script({ findRegex: '/\\w/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  const second = applyRegexScripts('a b c', [script({ findRegex: '/\\w/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  assert.equal(first, 'x x x');
  assert.equal(second, first);
});

test('compileRegexCached 命中缓存并返回同一实例', () => {
  const a = compileRegexCached('/cache-me/g');
  const b = compileRegexCached('/cache-me/g');
  assert.equal(a, b);
  assert.ok(a instanceof RegExp);
});

test('compileRegex 仍按 /pattern/flags 解析并拒绝空表达式', () => {
  const re = compileRegex('/ab+c/i');
  assert.equal(re.source, 'ab+c');
  assert.equal(re.flags, 'i');
  assert.throws(() => compileRegex(''), /不能为空/);
});

test('替换文本中的 $0 视作整段匹配（兼容角色卡写法）', () => {
  const s = script({ findRegex: '/([\\s\\S]+?。)/g', replaceString: '$0<panel/>' });
  assert.equal(
    applyRegexScripts('第一句。第二句。', [s], REGEX_PLACEMENT.AI_OUTPUT),
    '第一句。<panel/>第二句。<panel/>'
  );
  // 已支持的原生写法不受影响
  const amp = script({ findRegex: '/x/g', replaceString: '[$&]' });
  assert.equal(applyRegexScripts('x', [amp], REGEX_PLACEMENT.AI_OUTPUT), '[x]');
  // $$0 表示字面量 $0，不能被当成整段匹配
  const literal = script({ findRegex: '/x/g', replaceString: '$$0' });
  assert.equal(applyRegexScripts('x', [literal], REGEX_PLACEMENT.AI_OUTPUT), '$0');
});

test('超长输入整条跳过正则：原文逐字返回，不做事后截断/尾部匹配', () => {
  const head = 'H'.repeat(6800000);
  const tail = 'foo';
  const long = head + tail;
  const scripts = [script({ findRegex: '/foo/g', replaceString: 'bar' })];
  const output = applyRegexScripts(long, scripts, REGEX_PLACEMENT.AI_OUTPUT);
  // 逐字返回（既不是「只改尾部」，也不是「只改头部」）
  assert.equal(output, long);
  assert.equal(output.length, long.length);
  // 反向确认：若实现退化成「只作用于尾部 N 字符」，尾部 foo 会被替换成 bar
  assert.equal(output.slice(-3), 'foo');

  // 尾部匹配的旧语义会让长消息前段的正则静默失效，这里确认前段也没有被动过
  const front = applyRegexScripts(
    `foo${'H'.repeat(6800000)}`,
    scripts,
    REGEX_PLACEMENT.AI_OUTPUT
  );
  assert.equal(front.slice(0, 3), 'foo');
  assert.equal(front.length, 6800003);
});

test('正常长度输入仍正常应用正则（fail-closed 没有过度修正）', () => {
  const normal = 'foo bar foo';
  assert.equal(
    applyRegexScripts(normal, [script({ findRegex: '/foo/g', replaceString: 'bar' })], REGEX_PLACEMENT.AI_OUTPUT),
    'bar bar bar'
  );
  // 恰好等于上限的输入仍然正常执行（边界是「大于」才跳过）
  const atLimit = `${'x'.repeat(19997)}foo`;
  assert.equal(atLimit.length, 20000);
  assert.equal(
    applyRegexScripts(atLimit, [script({ findRegex: '/foo/g', replaceString: 'bar' })], REGEX_PLACEMENT.AI_OUTPUT).slice(-3),
    'bar'
  );
  // 超出 1 个字符即整条跳过
  const overLimit = `${'x'.repeat(19998)}foo`;
  assert.equal(overLimit.length, 20001);
  assert.equal(
    applyRegexScripts(overLimit, [script({ findRegex: '/foo/g', replaceString: 'bar' })], REGEX_PLACEMENT.AI_OUTPUT),
    overLimit
  );
});

test('大型完整 HTML 替换文本按原长度完整写入', () => {
  const largeHtml = [
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"/></head>',
    '<body><main>',
    'x'.repeat(6800000),
    '</main><script>window.triggerSlash("/send ok")</script></body></html>',
  ].join('');
  const output = applyRegexScripts(
    '[代桔出品]',
    [script({ findRegex: '/\\[代桔出品\\]/g', replaceString: largeHtml })],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(output.length, largeHtml.length);
  assert.equal(output, largeHtml);
});

test('展示正则只处理 HTML 可见文本，不改写标签、脚本和样式', () => {
  const highlight = script({
    findRegex: '/(foo)/g',
    replaceString: '<strong>$1</strong>',
  });
  const output = applyRegexScripts(
    '<div>foo</div><script>const foo = 1;</script><style>.foo{}</style>',
    [highlight],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(
    output,
    '<div><strong>foo</strong></div><script>const foo = 1;</script><style>.foo{}</style>'
  );
});

test('展示正则的纯文本替换和删除不会修改脚本、样式与标签', () => {
  const replace = script({ findRegex: '/foo/g', replaceString: 'bar' });
  const replaced = applyRegexScripts(
    '<div>foo</div><script>const foo = 1;</script><style>.foo{}</style>',
    [replace],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(
    replaced,
    '<div>bar</div><script>const foo = 1;</script><style>.foo{}</style>'
  );

  const remove = script({ findRegex: '/foo/g', replaceString: '' });
  const removed = applyRegexScripts(
    '<div>foo</div><script>const foo = 1;</script><style>.foo{}</style>',
    [remove],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal(
    removed,
    '<div></div><script>const foo = 1;</script><style>.foo{}</style>'
  );
});

test('展示正则保留整条消息的 $ 锚点，不再逐段复制或错序', () => {
  const status = script({ findRegex: '/$/g', replaceString: '<div id="status">状态</div>' });
  const video = script({ findRegex: '/$/g', replaceString: '<video controls></video>' });

  const plain = applyRegexScripts(
    '第一段。第二段。',
    [status, video],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal((plain.match(/id="status"/g) || []).length, 1);
  assert.equal((plain.match(/<video/g) || []).length, 1);
  assert.ok(plain.indexOf('id="status"') < plain.indexOf('<video'));

  // 行内标签把正文切段时，仍然只各追加一次
  const withTag = applyRegexScripts(
    '第一段<br>第二段',
    [status, video],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.equal((withTag.match(/id="status"/g) || []).length, 1);
  assert.equal((withTag.match(/<video/g) || []).length, 1);
  assert.ok(withTag.indexOf('id="status"') < withTag.indexOf('<video'));
  assert.ok(withTag.includes('<br>'));
});

test('展示正则还原哨兵后标签与脚本逐字保留', () => {
  const append = script({ findRegex: '/$/g', replaceString: '<b>尾</b>' });
  const output = applyRegexScripts(
    '<div>文</div><script>const x = 1;</script>',
    [append],
    REGEX_PLACEMENT.AI_OUTPUT,
    { mode: 'display' }
  );
  assert.ok(output.includes('<div>文</div>'));
  assert.ok(output.includes('<script>const x = 1;</script>'));
  assert.ok(output.endsWith('<b>尾</b>'));
  assert.equal((output.match(/<b>尾<\/b>/g) || []).length, 1);
});

test('嵌套无界量词会被识别为潜在灾难性回溯', () => {
  assert.equal(isUnsafeRegexPattern('(a+)+'), true);
  assert.equal(isUnsafeRegexPattern('/(\\w+)*$/g'), true);
  assert.equal(isUnsafeRegexPattern('(?:a*)+'), true);
  assert.equal(isUnsafeRegexPattern('(a{2,3})+'), false);
  assert.equal(isUnsafeRegexPattern('(.*?)'), false);
  assert.equal(isUnsafeRegexPattern('a(b+c)d'), false);
});

test('无上界 {n,} 外层量词也被识别（{n,m} 有界仍放行）', () => {
  assert.equal(isUnsafeRegexPattern('(a+){2,}'), true);
  assert.equal(isUnsafeRegexPattern('(\\d*){2,}'), true);
  assert.equal(isUnsafeRegexPattern('/(a+){2,}b/g'), true);
  // 有上界不误伤
  assert.equal(isUnsafeRegexPattern('(a+){2,3}'), false);
  assert.equal(isUnsafeRegexPattern('(a+){2}'), false);
  assert.equal(isUnsafeRegexPattern('(a{2,3})+'), false);
});

test('安全检查与编译按同一 /pattern/ 解析口径：模式体内未转义斜杠不漏检', () => {
  // 模式体含未转义斜杠、尾部是灾难性回溯结构：按第一个 / 截断会漏检
  assert.equal(isUnsafeRegexPattern('/a(?:b+)+c/g'), true);
  assert.equal(isUnsafeRegexPattern('/a\\/b(?:c+)+/g'), true);
  // 普通写法不受影响
  assert.equal(isUnsafeRegexPattern('/a/b/g'), false);
  assert.equal(isUnsafeRegexPattern('/foo/g'), false);
  // 漏检回补：被标记的脚本会整条跳过，主线程不会执行会挂死的正则
  const unsafeSlash = script({ findRegex: '/a(?:b+)+c/g', replaceString: 'x' });
  assert.equal(applyRegexScripts('abc', [unsafeSlash], REGEX_PLACEMENT.AI_OUTPUT), 'abc');
});

test('潜在灾难性回溯脚本被跳过而不是挂起主线程', () => {
  const unsafe = script({ findRegex: '/(a+)+$/g', replaceString: 'x' });
  const input = 'a'.repeat(40);
  const output = applyRegexScripts(input, [unsafe], REGEX_PLACEMENT.AI_OUTPUT, { mode: 'display' });
  assert.equal(output, input);
});

test('体内无上界 {n,} 与 * / + 同一口径：(a{2,})+$ 与 (a+)+$ 同等对待', () => {
  // 体内量词是同文件 isUnboundedRepeatAfter 已认定为无上界的 {n,}
  assert.equal(isUnsafeRegexPattern('(a{2,})+$'), true);
  assert.equal(isUnsafeRegexPattern('(a{2,})+'), true);
  assert.equal(isUnsafeRegexPattern('(a{2,})*'), true);
  assert.equal(isUnsafeRegexPattern('(a{2,}){3,}'), true);
  assert.equal(isUnsafeRegexPattern('/(\\d{2,})+/g'), true);
  assert.equal(isUnsafeRegexPattern('(?:x{1,})+'), true);
  // 与 (a+)+$ 同等对待：同一条输入下两者行为一致（都被跳过，原文返回）
  const input = 'a'.repeat(40);
  const plus = applyRegexScripts(input, [script({ findRegex: '/(a+)+$/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  const braced = applyRegexScripts(input, [script({ findRegex: '/(a{2,})+$/g', replaceString: 'x' })], REGEX_PLACEMENT.AI_OUTPUT);
  assert.equal(plus, input);
  assert.equal(braced, plus);
});

test('有上界 {n,m} 与 {n} 仍放行（不误拦，防过度拦截）', () => {
  // 体内有界
  assert.equal(isUnsafeRegexPattern('a{2,3}'), false);
  assert.equal(isUnsafeRegexPattern('(a{2,3})+'), false);
  assert.equal(isUnsafeRegexPattern('(a{2,3}){4,5}'), false);
  assert.equal(isUnsafeRegexPattern('(a{2})+'), false);
  assert.equal(isUnsafeRegexPattern('(a{2,3})*$'), false);
  // 外层有界也不拦
  assert.equal(isUnsafeRegexPattern('(a{2,}){2,3}'), false);
  // 端到端：有界量词的正则照常生效（贪婪匹配 'aaa' 后剩余单个 'a' 不再匹配）
  assert.equal(
    applyRegexScripts('aaaa', [script({ findRegex: '/a{2,3}/g', replaceString: 'b' })], REGEX_PLACEMENT.AI_OUTPUT),
    'ba'
  );
  assert.equal(
    applyRegexScripts('aa', [script({ findRegex: '/a{2,3}/g', replaceString: 'b' })], REGEX_PLACEMENT.AI_OUTPUT),
    'b'
  );
});

test('跳过可归因：超长跳过与启发式跳过分别计数且可区分', () => {
  const unsafeScript = script({ findRegex: '/(a+)+$/g', replaceString: 'x' });
  const safeScript = script({ findRegex: '/foo/g', replaceString: 'bar' });

  // 1) 启发式跳过：skippedUnsafe 计数，applied 只算真正执行的
  const unsafeStats = applyRegexScripts(
    'foo',
    [unsafeScript, safeScript],
    REGEX_PLACEMENT.AI_OUTPUT,
    { withStats: true }
  );
  assert.equal(String(unsafeStats), 'bar');
  assert.equal(unsafeStats.value, 'bar');
  assert.equal(unsafeStats.applied, 1);
  assert.equal(unsafeStats.skippedUnsafe, 1);
  assert.equal(unsafeStats.skippedTooLong, 0);

  // 2) 超长跳过：skippedTooLong 计数，applied 为 0（整条跳过，不半套用）
  const longStats = applyRegexScripts(
    'x'.repeat(20001),
    [unsafeScript, safeScript],
    REGEX_PLACEMENT.AI_OUTPUT,
    { withStats: true }
  );
  assert.equal(longStats.skippedTooLong, 2);
  assert.equal(longStats.skippedUnsafe, 0, '超长整条跳过，不再逐条判定启发式');
  assert.equal(longStats.applied, 0);

  // 3) 两种跳过可区分：同样数量但落在不同字段
  assert.notEqual(unsafeStats.skippedUnsafe, longStats.skippedUnsafe);

  // 4) 不传 withStats 时返回原始字符串，既有调用方零改动
  const plain = applyRegexScripts('foo', [safeScript], REGEX_PLACEMENT.AI_OUTPUT);
  assert.equal(typeof plain, 'string');
  assert.equal(plain, 'bar');
  // 空列表也遵守同一契约
  assert.equal(typeof applyRegexScripts('foo', [], REGEX_PLACEMENT.AI_OUTPUT), 'string');
  assert.equal(applyRegexScripts('foo', [], REGEX_PLACEMENT.AI_OUTPUT, { withStats: true }).applied, 0);
});

test('注释显式声明启发式边界：不构成安全保证，并列出典型漏检形态', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/prompt/regexEngine.js', import.meta.url)),
    'utf8'
  );
  // 规格注释在文件头部（原 :11-16 一带）
  // 去掉 Markdown 强调符再断言，避免 `**不是**安全保证` 这类写法干扰字面匹配
  const header = source.slice(0, source.indexOf('function isUnboundedRepeatAfter')).replace(/\*/g, '');
  assert.ok(
    /不构成安全保证|不是安全保证|不构成.{0,6}保证/.test(header),
    '必须显式声明不是安全保证'
  );
  assert.ok(/启发式/.test(header), '必须声明这是启发式而非完备检测');
  // 典型漏检形态必须逐条列出（下游据此不得省略执行侧兜底）
  for (const shape of ['(a|aa)+', '(a|a?)+', '(\\w|\\w\\w)+']) {
    assert.ok(header.includes(shape), `漏检形态必须列出：${shape}`);
  }
  // 必须指向执行侧的 fail-closed 兜底
  assert.ok(header.includes('fail-closed'), '必须指向执行侧兜底');
  assert.ok(header.includes('localModel/adapter.js:278'), '必须引用 fail-closed 先例');
  // 不得声称能诊断「已发生」的冻结
  const statsComment = source.slice(source.indexOf('让调用方/日志能看出'), source.indexOf('export function applyRegexScripts'));
  assert.ok(statsComment.includes('根本不会返回'), '计数边界必须如实写清：冻结时不返回');
});

test('i18n 文案已收敛：不再声称「危险正则会被跳过」，且中英一致', () => {
  const pairs = [
    [zhCharacter['character.editor.regex.unsafeHint'], enCharacter['character.editor.regex.unsafeHint'], 'character.editor.regex.unsafeHint'],
    [zhForge['forge.regex.unsafeHint'], enForge['forge.regex.unsafeHint'], 'forge.regex.unsafeHint'],
  ];
  for (const [zh, en, key] of pairs) {
    assert.equal(typeof zh, 'string', `${key} 中文值存在`);
    assert.equal(typeof en, 'string', `${key} 英文值存在`);
    // 收敛为「已识别的……会被跳过」
    assert.ok(zh.includes('已识别'), `${key} 中文须限定为「已识别」`);
    assert.ok(/recognized/i.test(en), `${key} 英文须限定为 "recognized"`);
    // 必须声明启发式不是安全保证
    assert.ok(/并非安全保证|不是安全保证/.test(zh), `${key} 中文须声明非安全保证`);
    assert.ok(/not a safety guarantee/i.test(en), `${key} 英文须声明非安全保证`);
    // 不得再出现「存在嵌套无界量词」这种无限定的绝对说法
    assert.ok(!zh.includes('该表达式存在嵌套无界量词'), `${key} 中文不得保留旧的绝对表述`);
    assert.ok(!/^This expression has nested unbounded quantifiers/.test(en), `${key} 英文不得保留旧的绝对表述`);
  }
  // 旧的「引擎对灾难性回溯模式直接跳过」这类无限定注释也不得保留（下游据此省略兜底）
  const zhForgeSource = readFileSync(
    fileURLToPath(new URL('../src/i18n/locales/zh-CN/forge.js', import.meta.url)),
    'utf8'
  );
  assert.ok(!zhForgeSource.includes('引擎对灾难性回溯模式直接跳过'));
});
