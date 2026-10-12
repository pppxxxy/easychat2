// i18n 门禁规则本身的行为测试（eslint-rules/no-hardcoded-chinese.mjs）。
//
// 为什么单独测规则：规则是「防复发」的闸门，规则本身失效是**静默**的——它只会
// 什么都不报，看起来和「代码很干净」一模一样。首版就栽过一次（把 new Error 写成
// CallExpression，全部 throw 被静默漏掉）。这里用真实的 ESLint Linter 跑真实规则，
// 逐条钉住「该报的报、不该报的不报」。
//
// 第三批（2026-10-12）扩宽了 noHardcodedChineseText 的形态覆盖（join 分隔符 /
// 返回对象字面量 / 模块级非导出常量 / 中文标点），同时**实测后放弃**了「模板串里的
// 中文」这条候选。放弃的那条在下面用「不误报」用例钉住，理由见
// eslint-rules/no-hardcoded-chinese.mjs 头注释。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';

import { noHardcodedChinese, noHardcodedChineseText } from '../eslint-rules/no-hardcoded-chinese.mjs';

const linter = new Linter();

function lint(code, ruleName, rule) {
  return linter.verify(code, {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { local: { rules: { [ruleName]: rule } } },
    rules: { [`local/${ruleName}`]: 'error' },
  }).map(message => message.messageId);
}

const alertRule = code => lint(code, 'alert-rule', noHardcodedChinese);
const textRule = code => lint(code, 'text-rule', noHardcodedChineseText);

test('首批规则：Alert.alert 与 throw new Error 的中文字面量被抓出', () => {
  assert.deepEqual(alertRule("Alert.alert('标题', '正文');"), ['hardcoded', 'hardcoded']);
  assert.deepEqual(alertRule("throw new Error('出错了');"), ['hardcoded']);
  // 非中文 / 走 t() 的不报
  assert.deepEqual(alertRule("Alert.alert(t('a.b'), t('a.c'));"), []);
  assert.deepEqual(alertRule("throw new Error('boom');"), []);
  // 注释里的中文不算（AST 只看字面量）
  assert.deepEqual(alertRule('// 这里是中文注释\nconst a = 1;'), []);
  // 作为值传递的 new Error 不算（是否用户可见由调用点决定）
  assert.deepEqual(alertRule("const e = new Error('中文');"), []);
});

test('扩展规则：JSX 正文里的中文被抓出（首版最大盲区之一）', () => {
  assert.deepEqual(textRule('const A = () => <Text>你好</Text>;'), ['hardcodedJsx']);
  assert.deepEqual(textRule('const A = () => <Text>{t(\'a.b\')}</Text>;'), []);
  // 缩进空白不算中文
  assert.deepEqual(textRule('const A = () => (\n  <View>\n    <Text>x</Text>\n  </View>\n);'), []);
});

test('扩展规则：模块级**导出**常量的中文字面量被抓出（首版最大盲区之二）', () => {
  // 正是 chatConstants.js 曾经的形态
  assert.deepEqual(textRule("export const THINKING_PLACEHOLDER = '正在思考...';"), ['hardcodedConst']);
  // 对象/数组里的值同样算（THINKING_LEVEL_LABELS 的形态）
  assert.deepEqual(
    textRule("export const L = { low: '低', high: '高' };"),
    ['hardcodedConst', 'hardcodedConst']
  );
  assert.deepEqual(textRule("export const L = ['甲', '乙'];"), ['hardcodedConst', 'hardcodedConst']);
  // 导出 i18n key 才是正确形态
  assert.deepEqual(textRule("export const KEY = 'chat.thinking.placeholder';"), []);
});

test('扩展规则：不该报的都不报（避免把检测做成噪音）', () => {
  // 正则字面量（匹配用）
  assert.deepEqual(textRule("export const RE = /失败|错误/;"), []);
  // 注释
  assert.deepEqual(textRule('// 中文注释\nexport const A = 1;'), []);
  // 函数体内未导出的字符串常量（有意不覆盖，靠 review）——第三批有专门用例钉住
  assert.deepEqual(textRule("export function f() { const label = '取消'; return label; }"), []);
  // 英文 / 走 t()
  assert.deepEqual(textRule("export const A = 'ok';"), []);
  assert.deepEqual(textRule("export const A = t('a.b');"), []);
});

test('扩展规则：与首批规则是两条独立规则（互不覆盖对方的盲区）', () => {
  // JSX 正文 / 导出常量不在首批规则里
  assert.deepEqual(alertRule('const A = () => <Text>你好</Text>;'), []);
  assert.deepEqual(alertRule("export const X = '中文';"), []);
  // Alert/throw 不在扩展规则里（沿用首批的清单，不重复报）
  assert.deepEqual(textRule("Alert.alert('标题');"), []);
  assert.deepEqual(textRule("throw new Error('出错了');"), []);
});

// ---------------------------------------------------------------------------
// 第三批（2026-10-12）：join() 分隔符 / 返回对象字面量 / 模块级非导出常量 / 中文标点。
// 这一批补的是「规则看不见」的形态盲区——不是「不报」，是 AST 形状压根没被匹配。
// 同批还**实测后放弃**了「模板串里的中文」（它与提示词在 AST 上同形，无简单判据可分离），
// 下面的「不误报」用例把它钉住，避免以后有人「顺手」加上去把清单撑爆。
// ---------------------------------------------------------------------------

test('第三批：join() 的中文分隔符被抓出（含「只有标点、没有汉字」的情况）', () => {
  // 用表达式语句隔离出 join() 这一条路径——写成 `const s = …` 会先被「模块级常量」
  // 那条路径命中（见下面「优先级 / 去重」用例），messageId 就不是 hardcodedJoin 了。
  assert.deepEqual(textRule("list.join('、');"), ['hardcodedJoin']);
  // 全角空格也是中文排版分隔符
  assert.deepEqual(textRule("list.join('　');"), ['hardcodedJoin']);
  // 一个汉字都没有：旧口径（只查 \u4e00-\u9fff）会**整类**漏掉
  assert.deepEqual(textRule("list.join('；');"), ['hardcodedJoin']);
  assert.deepEqual(textRule("list.join('｜');"), ['hardcodedJoin']);
  // 函数体内的 join 同样命中（真实命中大多长这样，如 CardForgeEditor.js）
  assert.deepEqual(textRule("function f() { return list.join('、'); }"), ['hardcodedJoin']);
  // 英文分隔符 / 变量分隔符 / 空串 / 转义换行都不报
  assert.deepEqual(textRule("list.join(', ');"), []);
  assert.deepEqual(textRule("list.join(' / ');"), []);
  assert.deepEqual(textRule("list.join(sep);"), []);
  assert.deepEqual(textRule("list.join('');"), []);
  assert.deepEqual(textRule("list.join('\\n');"), []);
  // split 的分隔符是「输入」不是「输出」，不在此列
  assert.deepEqual(textRule("text.split('、');"), []);
  // 走 i18n 的分隔符才是正确形态
  assert.deepEqual(textRule("list.join(t('common.listSeparator'));"), []);
});

test('第三批：函数返回的对象字面量里的中文被抓出（label 会被拼进英文句子）', () => {
  // 正是 src/localModel/modelCompatibility.js 的形态：
  //   return { tier: 'unknown', label: '内存未知', budgetBytes: 0 };
  assert.deepEqual(
    textRule("function f() { return { tier: 'unknown', label: '内存未知' }; }"),
    ['hardcodedReturnObject']
  );
  // 嵌套对象 / 数组里的值同样算
  assert.deepEqual(textRule("function f() { return { a: { b: '中文' } }; }"), ['hardcodedReturnObject']);
  assert.deepEqual(
    textRule("function f() { return { a: ['甲', '乙'] }; }"),
    ['hardcodedReturnObject', 'hardcodedReturnObject']
  );
  // 返回 i18n key（或调用方 t() 取值）才是正确形态
  assert.deepEqual(textRule("function f() { return { tier: 'unknown', labelKey: 'localModel.mem.unknown' }; }"), []);
  assert.deepEqual(textRule("function f() { return { label: t('a.b') }; }"), []);
  // 只认「直接返回的对象字面量」：返回标识符 / 调用结果 / 数组字面量都不在此列
  assert.deepEqual(textRule("function f() { const o = { label: '中文' }; return o; }"), []);
  assert.deepEqual(textRule("function f() { return build('中文'); }"), []);
  assert.deepEqual(textRule("function f() { return ['中文']; }"), []);
});

test('第三批：模块级**非导出**常量里的中文被抓出（不导出也一样会被读走）', () => {
  // 正是 src/cardForge/forge/shared.js 的形态：const FIELD_LABELS = { name: '角色名' }
  assert.deepEqual(textRule("const FIELD_LABELS = { name: '角色名' };"), ['hardcodedModuleConst']);
  // 数组里的值同样算（src/moments/affinity.js 的情感词表形态）
  assert.deepEqual(
    textRule("const POSITIVE_WORDS = ['喜欢', '开心'];"),
    ['hardcodedModuleConst', 'hardcodedModuleConst']
  );
  // 与「导出常量」是同一条检测的两个出口，messageId 不同（便于区分修法）
  assert.deepEqual(textRule("export const FIELD_LABELS = { name: '角色名' };"), ['hardcodedConst']);
  // 模块顶层的 if/for 块里的常量同样算「模块级」（判据是「祖先里没有函数」，
  // 而不是「parent 恰好是 Program」——用后者会漏掉这一形态）
  assert.deepEqual(textRule("if (x) { const A = '中文'; }"), ['hardcodedModuleConst']);
  // 走 i18n key 才是正确形态
  assert.deepEqual(textRule("const FIELD_LABELS_KEY = { name: 'cardForge.field.name' };"), []);
});

test('第三批：**函数体内**的普通字符串常量不报（有意保留的口径，别改成覆盖）', () => {
  // 理由：imageDescriptionPrompt.js 记录过这条口径——函数体里的中文绝大多数是模型
  // 提示词；覆盖它等于把几百处提示词塞进冻结清单，规则立刻失去信噪比。
  assert.deepEqual(textRule("function f() { const label = '取消'; return label; }"), []);
  assert.deepEqual(textRule("export function f() { const label = '取消'; return label; }"), []);
  // 箭头函数体同理——**包括**「模块级常量 = 箭头函数」这种形态：中文落在函数体里，
  // 不该被外层常量的 init 递归顺手捞出来（collectChineseLiterals 不下钻函数体）
  assert.deepEqual(textRule("const build = () => { const label = '取消'; return label; };"), []);
  assert.deepEqual(textRule("const H = { run: () => { const label = '取消'; return label; } };"), []);
  // 类方法体 / static 块同理
  assert.deepEqual(textRule("class A { m() { const label = '取消'; return label; } }"), []);
  assert.deepEqual(textRule("class A { static { const label = '取消'; } }"), []);
  // 对照组：模块级常量里的中文照报——证明上面的「不报」不是因为整条规则失效
  assert.deepEqual(textRule("const L = { label: '取消' };"), ['hardcodedModuleConst']);
});

test('第三批：中文标点也计入（旧口径只查汉字，`join(\'、\')` 这类整类漏掉）', () => {
  assert.deepEqual(textRule('const A = () => <Text>：</Text>;'), ['hardcodedJsx']);
  assert.deepEqual(textRule("export const SEP = '、';"), ['hardcodedConst']);
  assert.deepEqual(textRule("export const P = { lead: '（', tail: '）' };"), ['hardcodedConst', 'hardcodedConst']);
  // 全角字母数字**不算**中文文案（避免误报，例如用全角数字对齐的日志）
  assert.deepEqual(textRule("export const W = 'ＡＢＣ１２３';"), []);
  assert.deepEqual(textRule("const s = list.join('ＡＢ');"), []);
});

test('第三批：同一处中文只报一次（join 与常量/返回对象两条路径重叠时不重复计数）', () => {
  // 导出常量里嵌 join：常量那条路径先命中（VariableDeclaration 先于子节点），join 不重复报
  assert.deepEqual(textRule("export const S = list.join('、');"), ['hardcodedConst']);
  // 模块级非导出常量里嵌 join：同上，命中「模块级常量」那条
  assert.deepEqual(textRule("const S = list.join('、');"), ['hardcodedModuleConst']);
  // 返回对象里嵌 join：返回对象那条路径先命中
  assert.deepEqual(textRule("function f() { return { sep: list.join('、') }; }"), ['hardcodedReturnObject']);
  // 函数体内的常量不属「模块级」，于是只剩 join 这一条路径命中
  assert.deepEqual(textRule("export function f() { const S = list.join('、'); }"), ['hardcodedJoin']);
});

test('第三批：不误报（模型提示词 / 正则 / 路由名 / 纯 ASCII 模板串）', () => {
  // 模型提示词模板串：**有意不覆盖**。实测模板串里 384 处 / 94 文件，约六成是
  // 模型提示词或 agent 内部工具文案（散落在 workspace/chat/moments/books/music/diary
  // 等 9 棵树），写成规则等于往冻结清单塞 ~100 行「其实不该迁」的条目。
  // ⚠️ 已知盲区：因此 advanced.js:139/166 与 modelParams.js:90 两处用户可见中文仍看不见。
  assert.deepEqual(textRule('const PROMPT = `请把下面这段话翻译成英文。`;'), []);
  assert.deepEqual(textRule('const PROMPT = `输出格式：\\n- 每行一条`;'), []);
  assert.deepEqual(textRule("export const P = `世界书条目 ${i + 1}`;"), []);
  // 正则字面量（匹配用；value 是 RegExp 对象而非字符串，天然不计入）
  assert.deepEqual(textRule("export const RE = /失败|错误|、/;"), []);
  assert.deepEqual(textRule("const SEP = /[，。；]/;"), []);
  // 路由名是 ASCII 标识符，不是文案
  assert.deepEqual(textRule("navigation.navigate('ChatScreen', { id });"), []);
  assert.deepEqual(textRule("export const ROUTES = { chat: 'Chat', settings: 'Settings' };"), []);
  // 纯 ASCII 模板串 / 拼接
  assert.deepEqual(textRule('const P = `hello ${name}, you have ${n} items`;'), []);
  assert.deepEqual(textRule("const s = list.join(', ') + ' / ' + tail;"), []);
  // 注释里的中文不算（AST 只看字面量）
  assert.deepEqual(textRule('// 这里写中文注释\nconst a = list.join(",");'), []);
});
