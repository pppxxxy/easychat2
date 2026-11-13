// 媒体 URL 映射（design.md「适配层契约 5」）表驱动测试。
//
// 附带一条同源钉：MEDIA_DIRECTORIES 必须与 src/storage/dataBackup.js 的
// BACKUP_MEDIA_DIRECTORIES 逐项一致（值 + 顺序）。目录清单是跨端恢复时
// 「哪些路径要重写」的唯一口径，漂移会导致恢复后图片不显示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MEDIA_DIRECTORIES, mediaUrl } from '../../src/platform/mediaUrl.js';

test('mediaUrl：Android / Windows / 相对路径 / 未知目录的映射表', () => {
  const cases = [
    // Android 绝对路径
    ['file:///data/user/0/com.easychat2/files/chat-images/a.jpg', 'easychat2-media://media/chat-images/a.jpg'],
    // Windows file URL（带盘符，空格的 percent-encoding 要还原再编码）
    ['file:///C:/Users/x/AppData/Roaming/EasyChat2/documents/chat-images/a%20b.png', 'easychat2-media://media/chat-images/a%20b.png'],
    // Windows 裸路径
    ['C:\\Users\\x\\EasyChat2\\documents\\voice\\v1.mp3', 'easychat2-media://media/voice/v1.mp3'],
    // 相对片段（历史备份里的相对路径）
    ['chat-images/rel.jpg', 'easychat2-media://media/chat-images/rel.jpg'],
    // 未知目录：不映射（调用方保留原 URI 并标记媒体缺失）
    ['file:///data/user/0/com.easychat2/files/other/a.jpg', null],
    // 空值/非路径
    ['', null],
    [null, null],
    // 目录名不能被子串误命中（chat-images-extra 不是 chat-images）
    ['file:///x/chat-images-extra/a.jpg', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(mediaUrl(input), expected, `mediaUrl(${JSON.stringify(input)})`);
  }
});

test('MEDIA_DIRECTORIES 与 dataBackup 的 BACKUP_MEDIA_DIRECTORIES 同源（值 + 顺序）', () => {
  const dataBackupUrl = new URL('../../../src/storage/dataBackup.js', import.meta.url);
  const mediaPathsUrl = new URL('../../../src/cardForge/mediaPaths.js', import.meta.url);
  const sources = [fs.readFileSync(dataBackupUrl, 'utf8'), fs.readFileSync(mediaPathsUrl, 'utf8')];

  // 解析两处源文件里的 `const X_DIRECTORY = 'value'` 常量。
  const constants = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(/const (\w+_DIRECTORY) = '([^']+)'/g)) {
      constants.set(match[1], match[2]);
    }
  }

  const listBlock = sources[0].match(/BACKUP_MEDIA_DIRECTORIES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(listBlock, '解析 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES 失败');
  const identifiers = listBlock[1].split(',').map(entry => entry.trim()).filter(Boolean);
  assert.ok(identifiers.length >= 9, `目录清单规模异常（${identifiers.length}）`);

  const expected = identifiers.map(identifier => {
    assert.ok(constants.has(identifier), `找不到目录常量定义：${identifier}`);
    return constants.get(identifier);
  });
  assert.deepEqual(
    [...MEDIA_DIRECTORIES],
    expected,
    '桌面端媒体目录清单必须与 src/storage/dataBackup.js 完全一致（值 + 顺序）'
  );
});
