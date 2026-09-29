import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(HERE, '..', 'App.js'), 'utf8');

test('主动消息桥接使用导航容器 ref 而非 useNavigation', () => {
  // ProactiveMessageBridge 挂在 NavigationContainer 下、不在 navigator 内；
  // useNavigation 会回退到容器 ref，且容器未就绪时 navigate 会抛错。
  assert.ok(APP_SOURCE.includes('createNavigationContainerRef'));
  assert.ok(!APP_SOURCE.includes('useNavigation'));
});

test('导航未就绪时先入队，就绪后再消费', () => {
  assert.match(APP_SOURCE, /navigationRef\.isReady\(\)/);
  assert.ok(APP_SOURCE.includes('pendingRoleRef'));
  assert.match(APP_SOURCE, /onReady=\{\(\) => setNavigationReady\(true\)\}/);
  assert.match(APP_SOURCE, /<ProactiveMessageBridge navigationReady=\{navigationReady\} \/>/);
});

test('openRole 与消费 effect 都门控 loaded，避免加载完成前消费掉 roleId', () => {
  // 冷启动时 loaded 之前调 switchCharacter 会抛错，roleId 既没入队、原生也已清空，
  // 消费一次即永久丢失。修复要求 openRole 与消费 effect 都先判 loaded。
  const bridge = APP_SOURCE.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/);
  assert.ok(bridge, '未找到 ProactiveMessageBridge');
  assert.match(bridge[0], /if \(!loaded \|\| !navigationReady \|\| !navigationRef\.isReady\(\)\)/);
  assert.match(bridge[0], /if \(!loaded \|\| !navigationReady \|\| !pendingRoleRef\.current\) return;/);
  assert.ok(bridge[0].includes('switchCharacter'), 'bridge 应仍调用 switchCharacter');
});