// 角色标签渲染的稳定性守卫。
//
// 导入的第三方角色卡可能带重复标签（addTag 会去重，但导入路径不保证）。
// 若标签 chips 用 tag 本身作 React key，重复标签会产生重复 key 警告，且删除
// 某一项时 React 的复用可能错位。统一改用 `tag + index` 复合 key。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/CharacterScreen.js'), 'utf8');

test('标签 chips 使用复合 key，不用 tag 本身（防重复标签警告/复用错位）', () => {
  assert.ok(!/key=\{tag\}/.test(source), '不得用 tag 直接作 key');
  const composite = source.match(/key=\{`\$\{tag\}-\$\{index\}`\}/g) || [];
  assert.ok(composite.length >= 2, `标签渲染应有至少 2 处复合 key，实际 ${composite.length}`);
});
