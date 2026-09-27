import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  getCharacterEditGuard,
  setCharacterEditGuard,
} from '../src/characterEditGuard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(HERE, '..', 'App.js'), 'utf8');
const CHARACTER_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'CharacterScreen.js'), 'utf8');

test('未保存信箱默认安全：无脏值不误拦截', async () => {
  const guard = getCharacterEditGuard();
  assert.equal(guard.dirty, false);
  assert.equal(await guard.save(), false);
});

test('信箱注册与回落', async () => {
  const order = [];
  setCharacterEditGuard({ dirty: true, save: async () => { order.push('save'); return true; } });
  const active = getCharacterEditGuard();
  assert.equal(active.dirty, true);
  assert.equal(await active.save(), true);
  assert.deepEqual(order, ['save']);
  // 卸载/重置回落安全值
  setCharacterEditGuard(null);
  const reset = getCharacterEditGuard();
  assert.equal(reset.dirty, false);
  assert.equal(await reset.save(), false);
});

test('信箱规范化非法输入', () => {
  setCharacterEditGuard({ dirty: 'yes' });
  assert.equal(getCharacterEditGuard().dirty, false);
  setCharacterEditGuard({ dirty: true });
  // save 缺失时回落为永远 false 的安全函数
  assert.equal(typeof getCharacterEditGuard().save, 'function');
  setCharacterEditGuard(null);
});

test('Tab 切换拦截：确认框提供保存并离开', () => {
  assert.ok(APP_SOURCE.includes("screenListeners={{ tabPress: handleTabPress }}"));
  assert.ok(APP_SOURCE.includes('event.preventDefault();'));
  assert.ok(APP_SOURCE.includes("text: '保存并离开'"));
  assert.ok(APP_SOURCE.includes("text: '直接离开'"));
  assert.ok(APP_SOURCE.includes("text: '留下编辑'"));
  // 保存成功才切换；失败留在角色页由 save 内部弹错误
  assert.ok(APP_SOURCE.includes('const saved = await guard.save();'));
  assert.ok(APP_SOURCE.includes('if (saved) navigationRef.navigate(target);'));
  // 只拦截「从角色页离开」：目标仍是角色页或当前不在角色页时放行
  assert.ok(APP_SOURCE.includes("currentName !== '角色' || !target || target === '角色'"));
});

test('save 返回布尔且角色页注册信箱', () => {
  // save 各中断路径 return false、落库成功 return true
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("Alert.alert('角色加载中', '请稍候再保存。');\n      return false;"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("if (formSignatureRef.current !== saveFormSignature) return true;"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return true;'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return false;'));
  // 渲染提交后同步信箱；卸载/变化时回落安全值
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('setCharacterEditGuard({ dirty: formReady && formDirty, save });'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return () => setCharacterEditGuard(null);'));
});

test('编辑草稿防丢链路完整接线', () => {
  // 防抖暂存：编辑 800ms 后写草稿；表单回到与角色一致时清草稿
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('saveCharacterEditDraft(characterId, formState, savedFormSignature)'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('}, 800);'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('clearCharacterEditDraft(characterId).catch(() => {});'));
  // seed 完成后读即取走检测草稿，恢复/丢弃二选一；表单归属变化时丢弃不误恢复
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('takeCharacterEditDraft(draftOwnerId)'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("if (formOwnerIdRef.current !== draftOwnerId || seededIdRef.current !== draftOwnerId) return;"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("text: '恢复',"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('applyDraftFormState(buildCharacterFormState(draft.formState))'));
  // 保存成功与用户放弃切换都清草稿
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("clearCharacterEditDraft(character.id).catch(() => {});"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("clearCharacterEditDraft(activeId).catch(() => {});"));
});

test('脏判定以 seed 快照为基准，不因角色后台更新误报', () => {
  // 根因：旧口径「表单 vs 角色当前内容」——角色内容会被记忆摘要写入世界书、
  // 其他页面保存等后台更新，导致用户没动表单也被判为有未保存修改。
  // 新口径「表单 vs seed 快照」才直接反映「用户改了没保存」。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes(
    'const formDirty = formReady && currentFormSignature !== seededFormSignatureRef.current;'
  ));
  assert.equal(
    CHARACTER_SCREEN_SOURCE.includes('const formDirty = currentFormSignature !== savedFormSignature;'),
    false
  );
  // formReady 闸门避免 seed 期间误报
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('const formDirty = formReady &&'));
});
