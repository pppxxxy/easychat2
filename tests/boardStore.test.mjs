// 跨会话黑板持久化（boardStore）测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlackboard } from '../src/agent/blackboard.js';
import {
  BOARD_FILE,
  loadPersistentBlackboard,
  savePersistentBlackboard,
  clearPersistentBlackboard,
} from '../src/workspace/boardStore.js';

function makeStore(files = {}) {
  return {
    files,
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      return { content: files[path] };
    },
    async writeWorkspaceFile({ path, content }) {
      files[path] = content;
      return { path };
    },
    async deleteFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      delete files[path];
      return { path };
    },
  };
}

test('save → load 往返：内容与署名保留、序号续接；空黑板不落盘', async () => {
  const store = makeStore({});
  const empty = createBlackboard();
  assert.equal(await savePersistentBlackboard(store, 'c', empty), false, '空黑板不写');
  assert.equal(BOARD_FILE in store.files, false);

  const board = createBlackboard();
  board.post({ topic: '结论', from: 'task-1', text: 'A 查完' });
  assert.equal(await savePersistentBlackboard(store, 'c', board), true);
  assert.ok(BOARD_FILE in store.files);

  const loaded = await loadPersistentBlackboard(store, 'c');
  const messages = loaded.read({ topic: '结论' }).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'A 查完');
  assert.equal(messages[0].from, 'task-1');
  assert.equal(loaded.post({ topic: '结论', text: '新的一条' }).seq, 2, '序号在播种后继续');
});

test('load：文件不存在 / 坏 JSON → 空黑板；clear 删除文件', async () => {
  assert.equal((await loadPersistentBlackboard(makeStore({}), 'c')).size(), 0);
  assert.equal((await loadPersistentBlackboard(makeStore({ [BOARD_FILE]: '{坏' }), 'c')).size(), 0);

  const store = makeStore({ [BOARD_FILE]: '{"version":1,"topics":{}}' });
  assert.equal(await clearPersistentBlackboard(store, 'c'), true);
  assert.equal(BOARD_FILE in store.files, false);
  assert.equal(await clearPersistentBlackboard(makeStore({}), 'c'), false, '文件不存在删除返回 false');
});

test('缺 store / 缺方法时安全降级（不抛错）', async () => {
  assert.equal((await loadPersistentBlackboard(null, 'c')).size(), 0);
  assert.equal(await savePersistentBlackboard(null, 'c', createBlackboard()), false);
  assert.equal(await clearPersistentBlackboard({}, 'c'), false);
});
