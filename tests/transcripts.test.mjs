// N2 L3：压缩归档 transcripts 的写入与 LRU 清理。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSCRIPT_KEEP,
  TRANSCRIPTS_DIR,
  buildTranscriptName,
  pruneTranscripts,
  writeTranscript,
} from '../src/workspace/transcripts.js';

function createMemoryStore() {
  const files = new Map();
  return {
    files,
    async writeWorkspaceFile({ path, content }) { files.set(path, String(content)); return { path, length: String(content).length }; },
    async listWorkspaceFiles({ subdir = '' } = {}) {
      const prefix = subdir ? `${subdir}/` : '';
      return [...files.keys()].filter(p => p.startsWith(prefix)).sort();
    },
    async deleteFile({ path }) { const had = files.delete(path); return { path, deleted: had }; },
  };
}

test('writeTranscript：写 .transcripts/<base36>.jsonl 并返回路径', async () => {
  const store = createMemoryStore();
  const stored = await writeTranscript({ store, characterId: 'c1', content: '{"a":1}', now: 1000 });
  assert.ok(stored.path.startsWith(`${TRANSCRIPTS_DIR}/`));
  assert.equal(store.files.get(stored.path), '{"a":1}');
  assert.match(buildTranscriptName(1000), /^[0-9a-z]+\.jsonl$/);
  assert.equal(await writeTranscript({ store: null, characterId: 'c1', content: 'x' }), null);
});

test('pruneTranscripts：保留最近 K 份，超出删最旧', async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i += 1) {
    await writeTranscript({ store, characterId: 'c1', content: `t${i}`, now: 1000 + i, keep: 3 });
  }
  const remaining = await store.listWorkspaceFiles({ subdir: TRANSCRIPTS_DIR });
  assert.equal(remaining.length, 3);
  assert.equal(remaining.some(p => p.includes(Number(1000).toString(36))), false, '最旧的被删');

  const removed = await pruneTranscripts({ store, characterId: 'c1', keep: 1 });
  assert.equal(removed, 2);
  assert.equal(TRANSCRIPT_KEEP, 5);
});
