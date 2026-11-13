// 内置角色素材落盘入口（character/artworkLoader.js）行为测试。
//
// 背景（design.md「共享层复用清单 A-2」）：把「打包资源落盘」从
// defaultCharacterAssets.js（含 CJS `require` 图片）外提成可注入实现，
// AppContext 只依赖注册表，桌面端才能零改动复用。
//
// 这条测试钉的是注册表契约本身：注入后委托、未注入返回空串、实现抛错时
// 回退空串（绝不让素材失败阻断启动）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  materializeDefaultArtwork,
  setArtworkLoader,
} from '../src/character/artworkLoader.js';

test('artworkLoader：未注册实现时返回空串（不抛错）', async () => {
  setArtworkLoader(null);
  assert.deepEqual(await materializeDefaultArtwork(), { avatarUri: '', bgUri: '' });
});

test('artworkLoader：注入后委托给实现并原样返回 uri', async () => {
  let calls = 0;
  setArtworkLoader(async () => {
    calls += 1;
    return { avatarUri: 'file:///documents/avatars/a.jpg', bgUri: 'file:///documents/avatars/b.jpg' };
  });
  const result = await materializeDefaultArtwork();
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    avatarUri: 'file:///documents/avatars/a.jpg',
    bgUri: 'file:///documents/avatars/b.jpg',
  });
  setArtworkLoader(null);
});

test('artworkLoader：实现抛错时回退空串（素材失败不阻断启动）', async () => {
  setArtworkLoader(async () => {
    throw new Error('disk full');
  });
  assert.deepEqual(await materializeDefaultArtwork(), { avatarUri: '', bgUri: '' });
  setArtworkLoader(null);
});

test('artworkLoader：实现返回残缺对象时逐字段兜底为空串', async () => {
  setArtworkLoader(async () => ({ avatarUri: 'file:///documents/avatars/a.jpg' }));
  assert.deepEqual(await materializeDefaultArtwork(), {
    avatarUri: 'file:///documents/avatars/a.jpg',
    bgUri: '',
  });
  setArtworkLoader(null);
});
