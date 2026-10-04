// 主题与内置资源落盘的源码/单一来源断言（相关模块依赖 RN 运行时，无法纯 Node 执行）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { THEMES } from '../src/theme/themes.js';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('主题 id 唯一且非空', () => {
  const ids = THEMES.map(theme => theme.id);
  assert.ok(ids.length >= 8);
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.ok(id, '主题必须有 id'));
});

test('外观设置的白名单以 THEMES 为单一来源，新增主题不会被规范化回 dark', () => {
  const source = read('src/storage/settings.js');
  assert.match(source, /import \{[^}]*THEMES[^}]*\} from '\.\.\/theme\/themes\.js'/, '应从 themes.js 导入主题表');
  assert.match(source, /const THEME_IDS = THEMES\.map/, '白名单应从 THEMES 派生，避免硬编码漏项');
});

test('内置默认角色资源走 expo-file-system/legacy 入口', () => {
  const source = read('src/character/defaultCharacterAssets.js');
  // SDK 54 主入口不导出 documentDirectory 且弃用方法会抛错，必须走 /legacy
  assert.match(source, /from 'expo-file-system\/legacy'/, '必须使用 legacy 入口');
  assert.doesNotMatch(source, /from 'expo-file-system'/, '不得使用主入口');
});
