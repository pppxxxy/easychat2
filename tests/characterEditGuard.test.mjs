import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  getCharacterEditGuard,
  isFormDirty,
  resolveTabName,
  setCharacterEditGuard,
  shouldConfirmTabLeave,
} from '../src/character/characterEditGuard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(HERE, '..', 'App.js'), 'utf8');
// 2026-10-05 CharacterScreen 拆分为 CharacterStack + character/CharacterLibraryScreen.js
// （列表页）与 character/CharacterDetailScreen.js（编辑表单、未保存拦截信箱、编辑草稿都在这里）。
// 下面所有源码断言的目标字符串都在详情页，故读取路径改指详情页，约束不变。
const CHARACTER_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'character', 'CharacterDetailScreen.js'), 'utf8');
const CHARACTER_LIBRARY_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'character', 'CharacterLibraryScreen.js'), 'utf8');

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
  // 文案改走 i18n key（值在 src/i18n/locales）
  assert.ok(APP_SOURCE.includes("text: tRef.current('app.tabLeave.saveAndLeave')"));
  assert.ok(APP_SOURCE.includes("text: tRef.current('app.tabLeave.leave')"));
  assert.ok(APP_SOURCE.includes("text: tRef.current('app.tabLeave.stay')"));
  // 保存成功才切换；失败留在角色页由 save 内部弹错误
  assert.ok(APP_SOURCE.includes('const saved = await guard.save();'));
  assert.ok(APP_SOURCE.includes('if (saved) navigationRef.navigate(targetName);'));
  // 只拦截「从角色页离开」：判定收敛到 shouldConfirmTabLeave 纯函数
  assert.ok(APP_SOURCE.includes('shouldConfirmTabLeave({ dirty: guard.dirty, currentName, targetName })'));
});

test('tabPress 的 target 是路由 key，必须先解析成路由名再导航', () => {
  // 回归：target 是 key（形如 聊天-xxxx），直接交给 navigate 会被当路由名而静默 no-op，
  // 导致「直接离开 / 保存并离开」都跳不走、点当前 tab 也误弹窗。
  assert.ok(APP_SOURCE.includes('resolveTabName(navigationRef.getRootState(), event && event.target)'));
  assert.ok(APP_SOURCE.includes('navigationRef.navigate(targetName)'));
  // 不得再直接把 key 当名字传给 navigate
  assert.equal(APP_SOURCE.includes('navigationRef.navigate(target)'), false);
});

test('resolveTabName：把路由 key 解析成路由名，认不出返回空', () => {
  const rootState = { routes: [ { key: '聊天-abc', name: '聊天' }, { key: '角色-xyz', name: '角色' } ] };
  assert.equal(resolveTabName(rootState, '聊天-abc'), '聊天');
  assert.equal(resolveTabName(rootState, '角色-xyz'), '角色');
  // 关键回归：key 本身不是路由名，不能原样返回
  assert.equal(resolveTabName(rootState, '聊天-abc') === '聊天-abc', false);
  assert.equal(resolveTabName(rootState, '不存在'), '');
  assert.equal(resolveTabName(null, '聊天-abc'), '');
  assert.equal(resolveTabName(rootState, ''), '');
});

test('shouldConfirmTabLeave：只有角色页有脏编辑且目标是别的 tab 才拦', () => {
  // 正常应拦：角色页 + 脏 + 切到聊天
  assert.equal(shouldConfirmTabLeave({ dirty: true, currentName: '角色', targetName: '聊天' }), true);
  // 没脏不拦
  assert.equal(shouldConfirmTabLeave({ dirty: false, currentName: '角色', targetName: '聊天' }), false);
  // 不在角色页不拦
  assert.equal(shouldConfirmTabLeave({ dirty: true, currentName: '聊天', targetName: '设置' }), false);
  // 目标是角色页本身（点当前 tab）不拦
  assert.equal(shouldConfirmTabLeave({ dirty: true, currentName: '角色', targetName: '角色' }), false);
  // target 解析不出来（key 未解析/导航未就绪）不拦，绝不误拦
  assert.equal(shouldConfirmTabLeave({ dirty: true, currentName: '角色', targetName: '' }), false);
});

test('save 返回布尔且角色页注册信箱', () => {
  // save 各中断路径 return false、落库成功 return true
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("Alert.alert('角色加载中', '请稍候再保存。');\n      return false;"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("if (formSignatureRef.current !== saveFormSignature) return true;"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');"));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return true;'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return false;'));
  // 渲染提交后同步信箱；卸载/变化时回落安全值
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('dirty: formReady && formDirty,'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('save: options => (saveRef.current ? saveRef.current(options) : Promise.resolve(false)),'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('return () => setCharacterEditGuard(null);'));
  // 回归：guard effect 的依赖不得直接含 save。save 声明在 effect 之后，Babel 把
  // const 降级为 var，effect 首轮求值依赖数组时 save 是 undefined，undefined===undefined
  // 会让 effect 永不重跑，guard 一直持有首次 dirty 时的旧闭包——「保存并离开」只落库
  // 旧表单，切回再切走又弹未保存。改用 saveRef 持有最新引用，effect 只依赖 dirty 闸门。
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('}, [formReady, formDirty, save]);'), false);
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('}, [formReady, formDirty]);'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('const saveRef = useRef(null);'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('saveRef.current = save;'));
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
  // 保存成功清草稿
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("clearCharacterEditDraft(character.id).catch(() => {});"));
  // 「用户放弃切换就清草稿」：原实现写死 `clearCharacterEditDraft(activeId)`。拆分后
  // 详情页不再持有 activeId 表单态，该清草稿动作改由列表页的 onSwitch 在用户点
  // 「放弃并切换」时执行——详情页此时尚未挂载（navigate 在切换成功之后），表单归属
  // 天然是即将切走的旧角色。这里按新机制断言同等约束：详情页必须有 activeId 这一来源，
  // 列表页的放弃分支必须清掉当前角色的草稿。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('activeId,'));
  assert.ok(CHARACTER_LIBRARY_SOURCE.includes('clearCharacterEditDraft(activeId).catch(() => {});'));
});

test('脏判定以 seed 快照为基准，不因角色后台更新误报', () => {
  // 根因：旧口径「表单 vs 角色当前内容」——角色内容会被记忆摘要写入世界书、
  // 其他页面保存等后台更新，导致用户没动表单也被判为有未保存修改。
  // 新口径以 seed 快照为主基准，才直接反映「用户改了没保存」。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('isFormDirty({'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('seededSignature: seededFormSignatureRef.current'));
  // 旧口径（把「表单 vs 角色内容」直接当判词）不得回潮
  assert.equal(
    CHARACTER_SCREEN_SOURCE.includes('const formDirty = currentFormSignature !== savedFormSignature;'),
    false
  );
  // formReady 闸门由 isFormDirty 内部处理
  // 2026-10-05 拆分：详情页与 characterEditGuard.js 同在 src/character/ 下，
  // 相对导入随之变为 './characterEditGuard.js'（原为 './character/characterEditGuard.js'）。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes("from './characterEditGuard.js'"));
});

test('保存后表单等于已保存内容即视为干净（规范化不致误报未保存）', () => {
  // 存储层保存时会规范化字段（id 去重、presets 补默认名等），回读内容可能与
  // save() 当时推进的 seed 基准逐字不同；若只比 seed，用户「明明保存了还弹未保存」。
  // 兜底：表单与当前已保存角色完全一致时判干净（只用于判干净，不会把后台更新误判为脏）。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('isFormDirty({'));

  // 纯函数逐场景验证
  // 1) 未编辑：表单 == seed 基准 → 干净
  assert.equal(isFormDirty({ formReady: true, currentSignature: 'A', seededSignature: 'A', savedSignature: 'B' }), false);
  // 2) 保存后存储规范化：表单 == 已保存内容（但 != seed 基准）→ 干净，不误报
  assert.equal(isFormDirty({ formReady: true, currentSignature: 'B', seededSignature: 'A', savedSignature: 'B' }), false);
  // 3) 后台更新：表单 == seed 基准，角色内容变了 → 干净
  assert.equal(isFormDirty({ formReady: true, currentSignature: 'A', seededSignature: 'A', savedSignature: 'C' }), false);
  // 4) 真正改了未保存：三个都不相等 → 脏
  assert.equal(isFormDirty({ formReady: true, currentSignature: 'D', seededSignature: 'A', savedSignature: 'B' }), true);
  // 5) seed 未完成 → 一律不脏（闸门）
  assert.equal(isFormDirty({ formReady: false, currentSignature: 'D', seededSignature: 'A', savedSignature: 'B' }), false);
});
