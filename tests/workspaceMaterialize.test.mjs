// C2 按需物化测试：路径解析 / URL / base64 解码 / contents 响应提取 / IO 薄壳 / 接线契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  base64ToBytes,
  buildContentsUrl,
  extractContentsText,
  materializeRepoFile,
  parseRepoFilePath,
} from '../src/workspace/repoMaterialize.js';

test('parseRepoFilePath：repos/<owner>/<repo>/<branch>/<rel>；不满足形态返回 null', () => {
  assert.deepEqual(
    parseRepoFilePath('repos/o/r/main/src/a.js'),
    { owner: 'o', repo: 'r', branch: 'main', rel: 'src/a.js' }
  );
  assert.deepEqual(
    parseRepoFilePath('repos/o/r/feature%2Fx/deep/file.md'),
    { owner: 'o', repo: 'r', branch: 'feature%2Fx', rel: 'deep/file.md' }
  );
  assert.equal(parseRepoFilePath('src/a.js'), null, '不在 repos 下');
  assert.equal(parseRepoFilePath('repos/o/r/main'), null, '段数不足（没有文件）');
  assert.equal(parseRepoFilePath(''), null);
  assert.equal(parseRepoFilePath(null), null);
});

test('buildContentsUrl：rel 逐段编码 + ref 编码', () => {
  assert.equal(
    buildContentsUrl({ owner: 'o', repo: 'r', ref: 'main', rel: 'src/a b/中文.md' }),
    'https://api.github.com/repos/o/r/contents/src/a%20b/%E4%B8%AD%E6%96%87.md?ref=main'
  );
  assert.equal(
    buildContentsUrl({ owner: 'o', repo: 'r', ref: 'feature/x', rel: 'a.js' }),
    'https://api.github.com/repos/o/r/contents/a.js?ref=feature%2Fx'
  );
});

test('base64ToBytes / extractContentsText：UTF-8 中文解码 + 上限形态如实返回', () => {
  assert.deepEqual([...base64ToBytes('aGVsbG8=')], [104, 101, 108, 108, 111], 'hello');
  assert.deepEqual([...base64ToBytes('aGVs\nbG8=')], [104, 101, 108, 108, 111], '带换行也认');
  const text = extractContentsText({ encoding: 'base64', content: '5L2g5aW9' });
  assert.equal(text.ok, true);
  assert.equal(text.text, '你好', 'UTF-8 多字节正确解码');
  // >1MB：GitHub 不内联 content —— 如实返回 none（调用方给「完整拉取」提示）
  assert.deepEqual(extractContentsText({ encoding: 'none' }), { ok: false, reason: 'none' });
  assert.deepEqual(extractContentsText(null), { ok: false, reason: 'none' });
});

test('materializeRepoFile：单文件拉取写沙盒；前置不满足零网络、失败不写入', async () => {
  const written = [];
  const store = {
    async writeWorkspaceFile({ path: file, content }) { written.push({ file, content }); },
  };
  const calls = [];
  const requestImpl = async (fetchImpl, url) => {
    calls.push(url);
    return { data: { encoding: 'base64', content: 'aGVsbG8=' } };
  };
  const result = await materializeRepoFile({
    store, characterId: 'c1', path: 'repos/o/r/main/src/a.js', token: 't', requestImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.chars, 5);
  assert.deepEqual(calls, ['https://api.github.com/repos/o/r/contents/src/a.js?ref=main']);
  assert.deepEqual(written, [{ file: 'repos/o/r/main/src/a.js', content: 'hello' }]);

  // 非 repos 路径 / 无 store：不发网络、不写
  assert.deepEqual(
    await materializeRepoFile({ store, path: 'src/a.js', requestImpl }),
    { ok: false, reason: 'notRepoPath' }
  );
  assert.deepEqual(
    await materializeRepoFile({ path: 'repos/o/r/main/a.js', requestImpl }),
    { ok: false, reason: 'noStore' }
  );
  assert.equal(calls.length, 1, '前置不满足时零网络');

  // encoding none（>1MB）：返回原因且不写
  const big = await materializeRepoFile({
    store,
    path: 'repos/o/r/main/big.bin',
    requestImpl: async () => ({ data: { encoding: 'none' } }),
  });
  assert.deepEqual(big, { ok: false, reason: 'none' });
  assert.equal(written.length, 1, '失败不写入任何内容');
});

test('C2 接线契约：read 工具透明物化 + 面板点开即拉 + 宿主注入（三道前置）', () => {
  const readTools = fs.readFileSync(path.resolve('src/workspace/toolDefs/readTools.js'), 'utf8');
  assert.ok(readTools.includes('options.materializer'), 'read 工具读失败时试物化');
  assert.ok(readTools.includes("typeof options.materializer !== 'function'"), '没注入 = 旧行为逐字节一致');

  const panel = fs.readFileSync(path.resolve('src/workspace/screen/GithubPanel.js'), 'utf8');
  assert.ok(panel.includes('virtualPaths.has(path)'), '只对未物化（云朵）文件按需拉');
  assert.ok(panel.includes('materializeRepoFile({ store, characterId, path, token })'), '点开即拉');
  assert.ok(panel.includes("t('workspace.github.materialize.fail')"), '失败如实报（不静默）');

  const chat = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(chat.includes('materializer: materializeForAgent'), '工作区宿主注入物化器');
  assert.ok(chat.includes('readRepoManifest(store, characterId, target)'), '前置之一：必须做过快速检出');
  assert.ok(chat.includes('item.path === target.rel'), '前置之二：文件必须在清单里');

  const native = fs.readFileSync(path.resolve('src/workspace/native.js'), 'utf8');
  assert.ok(native.includes('extras.materializer'), '注册入口透传');
});
