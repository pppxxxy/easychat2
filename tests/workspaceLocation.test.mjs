// 工作区根策略：纯函数（location.js）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafTreeUri,
  MAX_DISPLAY_NAME,
  normalizeWorkspaceLocation,
  resolveWorkspaceRoot,
  workspaceCapabilities,
  WORKSPACE_ROOT_KINDS,
} from '../src/workspace/location.js';

const SAF_URI = 'content://com.android.externalstorage.documents/tree/primary%3ADocs';

test('normalizeWorkspaceLocation：只认 content:// 的 saf，其余回应用内默认', () => {
  assert.deepEqual(normalizeWorkspaceLocation(null), { kind: 'app', uri: '', name: '' });
  assert.deepEqual(normalizeWorkspaceLocation('nope'), { kind: 'app', uri: '', name: '' });
  assert.deepEqual(normalizeWorkspaceLocation({ kind: 'saf' }), { kind: 'app', uri: '', name: '' });
  assert.deepEqual(normalizeWorkspaceLocation({ kind: 'saf', uri: 'file:///sdcard/Docs' }), { kind: 'app', uri: '', name: '' });
  assert.deepEqual(normalizeWorkspaceLocation({ kind: 'saf', uri: 'https://example.com' }), { kind: 'app', uri: '', name: '' });
  const saf = normalizeWorkspaceLocation({ kind: 'saf', uri: SAF_URI, name: 'Docs' });
  assert.equal(saf.kind, WORKSPACE_ROOT_KINDS.SAF);
  assert.equal(saf.uri, SAF_URI);
  assert.equal(saf.name, 'Docs');
  // 显示名截断，且缺名字时给空串（UI 用「已选文件夹」兜底）
  assert.equal(normalizeWorkspaceLocation({ kind: 'saf', uri: SAF_URI, name: 'x'.repeat(300) }).name.length, MAX_DISPLAY_NAME);
  assert.equal(normalizeWorkspaceLocation({ kind: 'saf', uri: SAF_URI }).name, '');
});

test('isSafTreeUri 只做前缀判断（能不能用由系统授权决定）', () => {
  assert.equal(isSafTreeUri(SAF_URI), true);
  assert.equal(isSafTreeUri('content://media/external/images/1'), true);
  assert.equal(isSafTreeUri('file:///sdcard/a'), false);
  assert.equal(isSafTreeUri(''), false);
  assert.equal(isSafTreeUri(null), false);
});

test('resolveWorkspaceRoot：外部根补尾斜杠，应用根原样返回', () => {
  assert.equal(resolveWorkspaceRoot(null, '/doc/workspace/'), '/doc/workspace/');
  assert.equal(resolveWorkspaceRoot({ kind: 'app' }, '/doc/workspace/'), '/doc/workspace/');
  assert.equal(resolveWorkspaceRoot({ kind: 'saf', uri: SAF_URI }, '/doc/workspace/'), `${SAF_URI}/`);
  // 已带尾斜杠不重复补
  assert.equal(resolveWorkspaceRoot({ kind: 'saf', uri: `${SAF_URI}/` }, '/doc/'), `${SAF_URI}/`);
});

test('workspaceCapabilities：外部根禁用命令执行（无 root 的 shell 碰不到 content://）', () => {
  const app = workspaceCapabilities({ location: null, shellAvailable: true });
  assert.equal(app.rootKind, WORKSPACE_ROOT_KINDS.APP);
  assert.equal(app.external, false);
  assert.equal(app.canList, true);
  assert.equal(app.canWrite, true);
  assert.equal(app.canEdit, true);
  assert.equal(app.canShell, true);
  assert.equal(app.shellUnavailableReason, '');

  // 没装原生 shell：如实说「不可用」
  const noShell = workspaceCapabilities({ location: null, shellAvailable: false });
  assert.equal(noShell.canShell, false);
  assert.equal(noShell.shellUnavailableReason, 'SHELL_NOT_AVAILABLE');

  // 外部根：即便装了 shell 也一律禁用
  const external = workspaceCapabilities({ location: { kind: 'saf', uri: SAF_URI, name: 'Docs' }, shellAvailable: true });
  assert.equal(external.rootKind, WORKSPACE_ROOT_KINDS.SAF);
  assert.equal(external.external, true);
  assert.equal(external.canShell, false);
  assert.equal(external.shellUnavailableReason, 'EXTERNAL_ROOT_NO_SHELL');
  // 外部根的读写能力完整：走的是 safStore，不是降级的 legacy
  assert.equal(external.canList, true);
  assert.equal(external.canRead, true);
  assert.equal(external.canWrite, true);
  assert.equal(external.canEdit, true);
});
