import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCardFromJson } from '../src/character/cardParser.js';

test('解析织语纯文本 JSON 并映射角色字段', () => {
  const text = `　{
　"spec": "zhiyu_agent_v1",
　"spec_version": "1.0",
　"data": {
　　"nickname": "星",
　　"greeting": "你好，{{user}}",
　　"setting": "保持角色语气
遵守角色设定",
　　"preset_dialogs": ["备用开场"],
　　"agent_regex": [{
　　"name": "替换文本",
　　"pattern": "旧",
　　"replace": "新",
　　"scope": ["user", "ai"]
　　}],
　　"worldbook": {
　　"entries": [{
　　"name": "房间",
　　"keywords": ["卧室"],
　　"content": "房间设定"
　　}]
　　}
　}
}`;
  const card = parseCardFromJson(text);
  assert.equal(card.name, '星');
  assert.equal(card.fields.firstMes, '你好，{{user}}');
  assert.equal(card.fields.systemPrompt, '保持角色语气\n遵守角色设定');
  assert.deepEqual(card.fields.alternateGreetings, ['备用开场']);
  assert.equal(card.regexScripts[0].findRegex, '旧');
  assert.equal(card.regexScripts[0].replaceString, '新');
  assert.deepEqual(card.regexScripts[0].placement, [1, 2]);
  assert.equal(card.worldInfo[0].comment, '房间');
  assert.equal(card.worldInfo[0].content, '房间设定');
});

test('字符串 alternate_greetings 保留为一条完整开场白', () => {
  const card = parseCardFromJson(JSON.stringify({
    name: '角色',
    alternate_greetings: '早上好，今天见。',
  }));
  assert.deepEqual(card.fields.alternateGreetings, ['早上好，今天见。']);
});

test('解析 BOM、全角空白和代码围栏包裹的 JSON', () => {
  const card = parseCardFromJson('\uFEFF```json\n{"name":"角色","first_mes":"你好"}\n```');
  assert.equal(card.name, '角色');
  assert.equal(card.fields.firstMes, '你好');
});

test('第三方扩展与顶层字段原样保留以便往返导出', () => {
  const card = parseCardFromJson(JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '作者卡',
      creator: '某作者',
      character_version: '3.1',
      extensions: {
        talkativeness: 0.8,
        fav: true,
        depth_prompt: { depth: 4, prompt: '持续设定' },
        regex_scripts: [{ scriptName: '内部', findRegex: 'a', replaceString: 'b' }],
        easychat2: { version: 1, character_presets: [] },
      },
    },
  }));
  assert.equal(card.extensions.talkativeness, 0.8);
  assert.equal(card.extensions.fav, true);
  assert.deepEqual(card.extensions.depth_prompt, { depth: 4, prompt: '持续设定' });
  assert.equal(card.extensions.regex_scripts, undefined);
  assert.equal(card.extensions.easychat2, undefined);
  assert.equal(card.extra.creator, '某作者');
  assert.equal(card.extra.character_version, '3.1');
  assert.equal(card.extra.name, undefined);
  assert.equal(card.regexScripts[0].findRegex, 'a');
});

test('世界书的 depth、probability、scan_depth 和 role 兼容 extensions 写法', () => {
  const card = parseCardFromJson(JSON.stringify({
    name: '角色',
    character_book: {
      entries: [{
        comment: '条目',
        keys: ['关键词'],
        content: '设定',
        role: 'assistant',
        extensions: {
          depth: 7,
          probability: 35,
          scan_depth: 9,
        },
      }],
    },
  }));
  const entry = card.worldInfo[0];
  assert.equal(entry.depth, 7);
  assert.equal(entry.probability, 35);
  assert.equal(entry.scanDepth, 9);
  assert.equal(entry.role, 'assistant');
});

// ---- 原型污染（P0）----
// 卡片 JSON 是第三方可控输入。修复前两个 collectPassthrough* 用 `output[key] = source[key]`
// 原样搬运未消费键：key === '__proto__' 时这句改的是 output 的**原型**（不产生 own 属性，
// Object.keys 里看不到它 —— 静默丢键，导出时写不回去，往返不保真）；'constructor' /
// 'prototype' 则会成为 own 属性被原样带出（只挡了一半）。下面三条一起钉死。
test('卡片里的 __proto__/constructor/prototype 不得改写透传对象的原型', () => {
  // ⚠️ 必须用**原始 JSON 文本**构造攻击形态：对象字面量里的 `__proto__: {...}` 是设原型，
  // 根本不是 own 键，用字面量写出来的「攻击」在解析前就已经不是攻击了。
  const card = parseCardFromJson(`{
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
      "name": "攻击卡",
      "creator": "某作者",
      "__proto__": { "polluted": "yes" },
      "constructor": { "polluted": "yes" },
      "prototype": { "polluted": "yes" },
      "extensions": {
        "talkativeness": 0.8,
        "__proto__": { "polluted": "yes" },
        "constructor": { "polluted": "yes" },
        "prototype": { "polluted": "yes" }
      }
    }
  }`);

  // 1) 透传对象的原型必须是 Object.prototype（旧实现下 extensions 这条必红）
  assert.equal(Object.getPrototypeOf(card.extensions), Object.prototype, 'extensions 的原型被改写');
  assert.equal(Object.getPrototypeOf(card.extra), Object.prototype, 'extra 的原型被改写');
  // 2) 保留键不得成为 own 属性，也不得从原型链上读到攻击者的值
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.prototype.hasOwnProperty.call(card.extensions, key), false, `extensions.${key} 不应存在`);
    assert.equal(Object.prototype.hasOwnProperty.call(card.extra, key), false, `extra.${key} 不应存在`);
  }
  assert.equal(Object.keys(card.extensions).includes('__proto__'), false, '危险键必须被丢弃，不能静默留成原型');
  assert.equal(card.extensions.polluted, undefined, '不得从被换掉的原型上读到攻击者的值');
  // 3) 没有升级成全局污染
  assert.equal(({}).polluted, undefined, 'Object.prototype 被写脏');
  // 4) 防过度拦截：其余第三方透传键照旧保留
  assert.equal(card.extensions.talkativeness, 0.8);
  assert.equal(card.extra.creator, '某作者');
});
