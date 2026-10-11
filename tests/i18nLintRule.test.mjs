// i18n 门禁规则本身的行为测试（eslint-rules/no-hardcoded-chinese.mjs）。
//
// 为什么单独测规则：规则是「防复发」的闸门，规则本身失效是**静默**的——它只会
// 什么都不报，看起来和「代码很干净」一模一样。首版就栽过一次（把 new Error 写成
// CallExpression，全部 throw 被静默漏掉）。这里用真实的 ESLint Linter 跑真实规则，
// 逐条钉住「该报的报、不该报的不报」。

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
  // 未导出的模块内部常量：多为匹配用关键词或模型提示词，不是给用户看的文案
  assert.deepEqual(textRule("const KEYWORDS = ['最新', '今天'];"), []);
  // 正则字面量（匹配用）
  assert.deepEqual(textRule("export const RE = /失败|错误/;"), []);
  // 注释
  assert.deepEqual(textRule('// 中文注释\nexport const A = 1;'), []);
  // 函数体内未导出的字符串常量（已知盲区，规则不覆盖，靠 review）
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
