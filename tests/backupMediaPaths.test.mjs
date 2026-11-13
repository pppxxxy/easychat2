// 备份媒体路径重写：Android/Windows 绝对路径 → 当前 documents 相对路径，双向一致。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeAbsoluteMediaPath,
  mediaRelativePathFromAbsolute,
  rewriteBackupMediaPaths,
  rewriteMediaUri,
} from '../src/storage/backupMediaPaths.js';

const ANDROID_DOCS = 'file:///data/user/0/com.easychat2/files/';
const WINDOWS_DOCS = 'file:///C:/Users/u/AppData/Roaming/EasyChat2/documents/';

test('mediaRelativePathFromAbsolute：Android file:// URI', () => {
  assert.equal(
    mediaRelativePathFromAbsolute('file:///data/user/0/com.easychat2/files/chat-images/abc.jpg'),
    'chat-images/abc.jpg'
  );
  assert.equal(
    mediaRelativePathFromAbsolute('file:///data/user/0/com.easychat2/files/stickers/%E5%BC%80%E5%BF%83.jpg'),
    'stickers/开心.jpg'
  );
});

test('mediaRelativePathFromAbsolute：Windows file URL 与反斜杠路径', () => {
  assert.equal(
    mediaRelativePathFromAbsolute('file:///C:/Users/u/AppData/Roaming/EasyChat2/documents/avatars/a.png'),
    'avatars/a.png'
  );
  assert.equal(
    mediaRelativePathFromAbsolute('C:\\Users\\u\\AppData\\Roaming\\EasyChat2\\chat-videos\\v.mp4'),
    'chat-videos/v.mp4'
  );
});

test('白名单外与相对路径不参与改写', () => {
  assert.equal(mediaRelativePathFromAbsolute('file:///C:/Windows/System32/x.png'), '');
  assert.equal(mediaRelativePathFromAbsolute('chat-images/a.jpg'), '');
  assert.equal(mediaRelativePathFromAbsolute('file:///data/user/0/pkg/chat-images/../secret.jpg'), '');
  assert.equal(rewriteMediaUri('https://example.com/a.png', WINDOWS_DOCS), 'https://example.com/a.png');
  assert.equal(looksLikeAbsoluteMediaPath('chat-images/a.jpg'), false);
});

test('rewriteMediaUri：换安装后收敛到新 documentDirectory', () => {
  assert.equal(
    rewriteMediaUri('file:///data/user/0/com.easychat2/files/chat-images/a.jpg', WINDOWS_DOCS),
    `${WINDOWS_DOCS}chat-images/a.jpg`
  );
  assert.equal(
    rewriteMediaUri('file:///C:/Users/u/AppData/Roaming/EasyChat2/documents/voice/v.m4a', ANDROID_DOCS),
    `${ANDROID_DOCS}voice/v.m4a`
  );
});

test('rewriteBackupMediaPaths：media 绝对路径转相对、存储嵌套 URI 重写、opaqueRaw 不动', () => {
  const payload = {
    schemaVersion: 1,
    storage: [
      {
        key: '@easychat2_character_index',
        value: {
          characters: [{
            id: 'c1',
            avatarUri: 'file:///data/user/0/old.pkg/files/avatars/c1.jpg',
            nested: [{ bg: 'C:\\Users\\u\\AppData\\Roaming\\EasyChat2\\characters\\c1.png' }],
          }],
          untouched: 'https://example.com/x.png',
        },
      },
      { key: '@easychat2_draft', opaqueRaw: 'avatar=file:///data/user/0/old.pkg/files/avatars/c1.jpg' },
    ],
    media: [
      { path: 'file:///data/user/0/old.pkg/files/chat-images/a.jpg', base64: 'AA==' },
      { path: 'chat-images/b.jpg', base64: 'BB==' },
    ],
  };
  const result = rewriteBackupMediaPaths(payload, { documentDirectory: WINDOWS_DOCS });
  assert.equal(result.rewrittenMediaPaths, 1);
  assert.equal(result.rewrittenUris, 2);
  assert.equal(payload.media[0].path, 'chat-images/a.jpg');
  assert.equal(payload.media[1].path, 'chat-images/b.jpg');
  assert.equal(
    payload.storage[0].value.characters[0].avatarUri,
    `${WINDOWS_DOCS}avatars/c1.jpg`
  );
  assert.equal(
    payload.storage[0].value.characters[0].nested[0].bg,
    `${WINDOWS_DOCS}characters/c1.png`
  );
  assert.equal(payload.storage[0].value.untouched, 'https://example.com/x.png');
  assert.equal(
    payload.storage[1].opaqueRaw,
    'avatar=file:///data/user/0/old.pkg/files/avatars/c1.jpg'
  );
});

test('往返：Android → Windows → Android 两次重写后仍指向同一相对路径', () => {
  const original = 'file:///data/user/0/com.easychat2/files/chat-images/a.jpg';
  const windows = rewriteMediaUri(original, WINDOWS_DOCS);
  const back = rewriteMediaUri(windows, ANDROID_DOCS);
  assert.equal(windows, `${WINDOWS_DOCS}chat-images/a.jpg`);
  assert.equal(back, `${ANDROID_DOCS}chat-images/a.jpg`);
});

test('未发生改写的子树保持原引用（大备份不做无谓拷贝）', () => {
  const inner = { text: 'hello', url: 'https://example.com/a.png' };
  const payload = { storage: [{ key: '@easychat2_x', value: { inner, list: [inner] } }], media: [] };
  rewriteBackupMediaPaths(payload, { documentDirectory: WINDOWS_DOCS });
  assert.equal(payload.storage[0].value.inner, inner);
  assert.equal(payload.storage[0].value.list[0], inner);
});
