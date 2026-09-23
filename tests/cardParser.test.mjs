import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCardFromJson } from '../src/cardParser.js';

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

test('解析 BOM、全角空白和代码围栏包裹的 JSON', () => {
  const card = parseCardFromJson('\uFEFF```json\n{"name":"角色","first_mes":"你好"}\n```');
  assert.equal(card.name, '角色');
  assert.equal(card.fields.firstMes, '你好');
});
