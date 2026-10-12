// 在线请求链路错误文案的 i18n 收敛（回归 2026-10-12 审查待办第 2 项）。
//
// 被钉住的两个盲区：
// 1. `src/network/requestTimeout.js` 用 `return '中文'` 给出超时文案——两条 lint 规则都
//    看不见函数体里的字符串字面量（规则只查 Alert.alert / throw new Error / JSX 正文 /
//    导出常量），所以英文用户拿到的是中文，且不会有人被拦下来。现在改成返回 i18n key。
// 2. `src/network/api.js` 的请求期错误文案同理（`new Error('中文')` 不是直接 throw，
//    规则 1 也看不见），现已全部走 tActive。
//
// 同时钉住**哨兵**的边界：EMPTY_REPLY_TEXT / CONFIG_CHANGED_ERROR 是身份比较与落盘数据，
// 故意不进 i18n——它们必须继续是中文常量，且必须带就地豁免与理由说明。防的是「下次有人
// 看到中文就顺手翻译掉」，那会让约 10 个模块的比较在语言切换后失效。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { localeSource } from './helpers/localeSource.mjs';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// 收集文件里所有含中文的字符串字面量（含模板串），跳过注释——注释不算文案。
function chineseLiterals(file) {
  const ast = babel.parseSync(fs.readFileSync(path.resolve(file), 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: file,
    parserOpts: { plugins: ['jsx'] },
  });
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'StringLiteral' && CJK.test(node.value)) found.push(node.value);
    if (node.type === 'TemplateLiteral') {
      node.quasis.forEach(q => { if (CJK.test(q.value.raw)) found.push(q.value.raw); });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = node[key];
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(ast.program);
  return found;
}

test('requestTimeout.js：判定层不含任何中文文案（超时文案改为返回 i18n key）', () => {
  assert.deepEqual(chineseLiterals('src/network/requestTimeout.js'), []);
  const source = fs.readFileSync(path.resolve('src/network/requestTimeout.js'), 'utf8');
  assert.ok(source.includes('timeoutMessageKey'), '应导出 timeoutMessageKey');
  assert.ok(!/export function timeoutMessage\b/.test(source), '旧的 timeoutMessage（返回文案）不得复活');
});

test('api.js：只剩两处哨兵常量（+ 一条诊断标签），且哨兵都带就地豁免与理由', () => {
  const literals = chineseLiterals('src/network/api.js');
  // 第三条是 recordDiagnostic 的上下文标签，**不是用户可见文案**（诊断日志只在
  // 设置 → 诊断里给开发者/用户排障看，lint 规则本身也明确把诊断排除在外），故保留中文。
  assert.deepEqual(
    literals.sort(),
    ['没有收到回复。', '模型来源已切换，请重新发送', '聊天接口请求失败'].sort(),
    'api.js 的中文字面量应只剩两个哨兵 + 一条诊断标签；其它错误文案必须走 tActive'
  );
  const source = fs.readFileSync(path.resolve('src/network/api.js'), 'utf8');
  assert.ok(/recordDiagnostic\([^)]*'聊天接口请求失败'/.test(source), '第三条应是诊断标签');
  // 每个哨兵都要有「为什么不能翻译」的说明 + eslint 就地豁免，否则下次会被顺手翻掉。
  const disables = source.match(/eslint-disable-next-line local-i18n\/no-hardcoded-chinese-text/g) || [];
  assert.equal(disables.length, 2, '两个哨兵各需一条就地豁免');
  assert.ok(source.includes('哨兵'), '必须写明「这是哨兵不是文案」的理由');
  assert.ok(source.includes('EMPTY_REPLY_TEXT') && source.includes('CONFIG_CHANGED_ERROR'));
});

test('超时/错误文案的三个新 key 在 zh-CN 与 en 都存在（漏译会让界面出现原始 key）', () => {
  const keys = ['error.api.timeoutFirstByte', 'error.api.timeoutIdle', 'error.api.timeoutNonstream'];
  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
  for (const key of keys) {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  }
});

test('空回复哨兵不得再长出第二份字面量（replyFlow 与 api.js 必须同源）', () => {
  const apiSource = fs.readFileSync(path.resolve('src/network/api.js'), 'utf8');
  const sentinel = /export const EMPTY_REPLY_TEXT = '([^']+)'/.exec(apiSource);
  assert.ok(sentinel, '未找到 EMPTY_REPLY_TEXT');
  const replyFlow = fs.readFileSync(path.resolve('src/chat/replyFlow.js'), 'utf8');
  assert.ok(
    replyFlow.includes(`'${sentinel[1]}'`),
    'replyFlow.js 的占位文案必须与 EMPTY_REPLY_TEXT 逐字一致——两处各写一份会在改动时静默漂移'
  );
  // 反向：不能又多出第三种写法
  const occurrences = replyFlow.split(`'${sentinel[1]}'`).length - 1;
  assert.equal(occurrences, 1, 'replyFlow 里该占位只应出现一次');
});
