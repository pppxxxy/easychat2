// easychat2-media:// 协议处理器：目录边界、MIME、缓存头与缺失文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createMediaHandler } from '../../electron/ipc/media.js';
import { makeSandbox } from '../helpers/sandbox.mjs';

test('媒体协议：documents 内的文件按扩展名给 MIME，禁止缓存', async () => {
  const sandbox = makeSandbox();
  try {
    const directory = path.join(sandbox.documentsRoot, 'chat-images');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'a.jpg'), Buffer.from([1, 2, 3]));
    const { handler } = createMediaHandler({ documentsRoot: sandbox.documentsRoot });
    const response = await handler({ url: 'easychat2-media://media/chat-images/a.jpg' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  } finally {
    sandbox.cleanup();
  }
});

test('媒体协议：越界路径无法逃出 documents、缺失文件 404、非协议 URL 403', async () => {
  const sandbox = makeSandbox();
  try {
    const { handler } = createMediaHandler({ documentsRoot: sandbox.documentsRoot });
    // URL 解析会先归一化 `..` 段：路径落回 documents 根内且文件不存在 ⇒ 404。
    // 关键性质是「不会返回根外文件」——不是 200。
    assert.equal((await handler({ url: 'easychat2-media://media/../secret.txt' })).status, 404);
    assert.equal((await handler({ url: 'easychat2-media://media/chat-images/missing.png' })).status, 404);
    assert.equal((await handler({ url: 'file:///C:/Windows/x.png' })).status, 403);
  } finally {
    sandbox.cleanup();
  }
});
