// 「角色库变更通知」注册表的纯逻辑测试。
//
// 这块逻辑很小，但它接在两条都要紧的边上：
//   - 写入侧：MCP 的 create/edit 写盘成功后调 notify（漏了 = 建完卡界面看不到）；
//   - 读取侧：AppContext 注册重载函数（漏了 = 通知空转，问题原样存在）。
// 所以这里按「注册/退订/容错」逐条钉，避免以后改 AppContext 时把订阅条件写坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  subscribeCharacterLibraryChange,
  notifyCharacterLibraryChanged,
  __resetCharacterLibraryListenersForTests,
} from '../src/context/characterLibrarySync.js';

test('注册后能收到通知，且带上调用方给的原因串', () => {
  __resetCharacterLibraryListenersForTests();
  const seen = [];
  const off = subscribeCharacterLibraryChange(reason => seen.push(reason));
  const notified = notifyCharacterLibraryChanged('character-write');
  assert.deepEqual(seen, ['character-write']);
  assert.equal(notified, 1, '返回值是实际通知到的数量');
  off();
  __resetCharacterLibraryListenersForTests();
});

test('退订之后不再收到通知', () => {
  __resetCharacterLibraryListenersForTests();
  const seen = [];
  const off = subscribeCharacterLibraryChange(reason => seen.push(reason));
  off();
  notifyCharacterLibraryChanged('character-write');
  assert.deepEqual(seen, []);
  __resetCharacterLibraryListenersForTests();
});

test('多个监听者都会收到；一个抛错不影响其它监听者', () => {
  // 现实里最多一个（AppContext），但注册表不该因为「第一个炸了」就丢掉后面的。
  __resetCharacterLibraryListenersForTests();
  const seen = [];
  const off1 = subscribeCharacterLibraryChange(() => {
    throw new Error('坏的监听器');
  });
  const off2 = subscribeCharacterLibraryChange(reason => seen.push(reason));
  // 不抛（否则调用方的成功写入会被通知失败拖成报错）
  assert.doesNotThrow(() => notifyCharacterLibraryChanged('character-write'));
  assert.deepEqual(seen, ['character-write']);
  off1();
  off2();
  __resetCharacterLibraryListenersForTests();
});

test('没人注册时通知是空操作（Node / CLI 桥环境）', () => {
  __resetCharacterLibraryListenersForTests();
  assert.equal(notifyCharacterLibraryChanged(), 0);
  assert.doesNotThrow(() => notifyCharacterLibraryChanged('anything'));
});

test('传入非函数不会注册，也不会让退订函数变成炸弹', () => {
  __resetCharacterLibraryListenersForTests();
  const off = subscribeCharacterLibraryChange(null);
  assert.equal(typeof off, 'function');
  assert.doesNotThrow(() => off());
  assert.equal(notifyCharacterLibraryChanged(), 0);
  __resetCharacterLibraryListenersForTests();
});

// ── 接线锚（AppContext / App.js 是 RN 组件，Node 里跑不起来） ─────────────
//
// 注册表本身测得再细，只要没人订阅、或订阅了却调错刷新函数，问题就原样存在
// （卡建成了但界面看不到）。所以按仓库既有的「源码锚」做法，钉住两侧的接线：
// 写入侧必须 notify，读取侧必须在常驻桥里 subscribe 且在根组件挂上。
test('接线锚：常驻桥订阅重读，并在退订时解绑（hook 内写在 effect 里）', () => {
  const hook = fs.readFileSync(path.resolve('src/context/useCharacterLibrarySync.js'), 'utf8');
  assert.ok(hook.includes('from \'./characterLibrarySync.js\''), 'hook 必须取订阅函数');
  const subAt = hook.indexOf('subscribeCharacterLibraryChange(');
  assert.ok(subAt > 0, 'hook 必须订阅角色库变更');
  // 订阅必须在 useEffect 内：否则每次渲染叠加一个监听器且永不释放。
  const effectAt = hook.lastIndexOf('useEffect(', subAt);
  assert.ok(effectAt > 0 && effectAt < subAt, '订阅必须写在 useEffect 内');
  // effect 必须把订阅返回的退订函数交回去，React 才能清理。
  assert.ok(hook.includes('return subscribeCharacterLibraryChange('), 'effect 必须直接 return 退订函数');
  assert.ok(hook.includes('.catch('), '刷新失败必须自己吞掉，不能冒泡给写入方');
  // 不是函数时不要订阅（守一手调用方传错）。
  assert.ok(hook.includes('typeof refresh !== \'function\''), '非函数参数必须直接跳过');

  const bridge = fs.readFileSync(
    path.resolve('src/startup/characterLibrarySyncBridge.js'),
    'utf8'
  );
  assert.ok(bridge.includes('useCharacterLibrarySync(refreshCharacters)'),
    '桥必须把 context 的排队版 refreshCharacters 交给 hook');

  // 必须在根组件挂载，否则没人订阅（AppProvider 之外拿不到 context）。
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const providerAt = app.indexOf('<AppProvider>');
  const closeAt = app.indexOf('</AppProvider>', providerAt);
  const bridgeAt = app.indexOf('<CharacterLibrarySyncStartup />');
  assert.ok(bridgeAt > providerAt && bridgeAt < closeAt,
    '常驻桥必须挂在 AppProvider 内部（否则 useApp 拿不到 context）');
});

test('接线锚：写入路径必须在落盘成功之后 notify，且不能是 await 阻塞返回', () => {
  const source = fs.readFileSync(
    path.resolve('src/workspace/toolDefs/charactersTools.js'),
    'utf8'
  );
  // 落盘调用现在是多行（带 expectedRevision 选项），按赋值语句开头定位。
  const saveAt = source.indexOf('const saved = await storage.saveCharacterLibrary(');
  assert.ok(saveAt > 0, '必须保留整库写回这一句');
  // 找**调用点**而不是函数定义：`function notifyChanged(reason)` 在文件前部。
  const notifyAt = source.indexOf("notifyChanged('character-write')");
  assert.ok(notifyAt > saveAt, 'notify 必须在落盘成功之后（失败时不该通知）');
  // 不能写成 `await notifyChanged(...)`：通知不是数据操作，不该拖慢工具返回。
  assert.ok(!/await\s+notifyChanged\(/.test(source), 'notify 不得被 await');
});

