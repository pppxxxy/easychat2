import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCharacterPresets,
  makeCharacterPresetId,
  normalizeCharacterPresets,
} from '../src/characterPresets.js';

test('角色预设规范化并补默认启用状态', () => {
  const presets = normalizeCharacterPresets([
    { id: 'style', name: '语气', prompt: '保持语气' },
    { name: '关闭', prompt: '不生效', disabled: true },
  ]);
  assert.equal(presets.length, 2);
  assert.equal(presets[0].enabled, true);
  assert.equal(presets[1].enabled, false);
  assert.ok(makeCharacterPresetId(presets).startsWith('character-preset-'));
});

test('从角色卡扩展字段读取角色预设', () => {
  const presets = extractCharacterPresets(
    {},
    { extensions: { easychat2: { character_presets: [{ name: '角色语气', prompt: '保持设定' }] } } },
    {}
  );
  assert.equal(presets[0].prompt, '保持设定');
});

test('兼容以 id 为键的预设对象', () => {
  const presets = normalizeCharacterPresets({
    style: { name: '语气', prompt: '保持设定' },
    detail: { prompt: '补充细节' },
  });
  assert.deepEqual(presets.map(item => item.id), ['style', 'detail']);
  assert.equal(presets[0].name, '语气');
});
