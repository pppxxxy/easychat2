// 角色标签渲染的稳定性守卫。
//
// 导入的第三方角色卡可能带重复标签（addTag 会去重，但导入路径不保证）。
// 若标签 chips 用 tag 本身作 React key，重复标签会产生重复 key 警告，且删除
// 某一项时 React 的复用可能错位。统一改用 `tag + index` 复合 key。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-05 CharacterScreen 拆分为 CharacterStack + character/CharacterLibraryScreen.js
// （列表页）与 character/CharacterDetailScreen.js（编辑表单）。两处标签 chips 现在都在
// 详情页（表单标签 + 角色数据里导入卡片的标签），断言目标随之改指详情页，约束不变。
const source = fs.readFileSync(path.resolve('src/character/CharacterDetailScreen.js'), 'utf8');

test('标签 chips 使用复合 key，不用 tag 本身（防重复标签警告/复用错位）', () => {
  assert.ok(!/key=\{tag\}/.test(source), '不得用 tag 直接作 key');
  const composite = source.match(/key=\{`\$\{tag\}-\$\{index\}`\}/g) || [];
  assert.ok(composite.length >= 2, `标签渲染应有至少 2 处复合 key，实际 ${composite.length}`);
});
