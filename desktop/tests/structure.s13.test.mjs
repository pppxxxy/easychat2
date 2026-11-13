// 桌面外壳结构守卫（S13）：扩展页与手机版同拓扑，且不再把可移植功能说成「不支持」。
//
// 手机版扩展页（src/extension/ExtensionHome.js）是 4 个分组共 13 个入口，每个入口
// 一个页面（ExtensionStack.js 的 Stack.Screen）。桌面此前把整页做成「暂不支持」清单，
// 而逐条核对依赖后发现：这些功能的数据层与纯逻辑全在 src/ 下，不依赖 Android 原生能力
// （music/library、books/library、storage/{moments,diary,schedule,worldMap}、
//  games/games、cardForge、imageGen 都是纯 JS）。
//
// 本文件钉住两件事：
//   ① 手机有的入口，桌面也必须有（否则又是「功能看起来丢了」）；
//   ② 「不可用」清单只能是**真的**依赖系统能力的那些（screenWatch/plugins/
//      scheduledTasks/localModels/workspaceTools），不能把没做的功能混进去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const MOBILE_HOME = read(ROOT, 'src', 'extension', 'ExtensionHome.js');
const MOBILE_STACK = read(ROOT, 'src', 'extension', 'ExtensionStack.js');
const EXT_SCREEN = read(DESKTOP, 'src', 'extension', 'ExtensionScreen.jsx');
const ROUTES = read(DESKTOP, 'src', 'extension', 'extensionRoutes.js');
const REASONS = read(DESKTOP, 'src', 'extension', 'unsupportedReasons.js');

test('手机扩展页的每个入口在桌面都有对应路由', () => {
  // 手机 GROUPS 里的 id（forge/image/moments/proactive/agentTask/schedule/diary/
  // screen/plugins/music/books/map/games）。
  const mobileIds = [...MOBILE_HOME.matchAll(/\{ id: '([a-zA-Z]+)', route:/g)].map(m => m[1]);
  assert.ok(mobileIds.length >= 12, `手机入口数量异常：${mobileIds.length}`);
  // 桌面必须覆盖的（除了依赖系统能力的 screen/plugins/agentTask）。
  const mustHave = mobileIds.filter(id => !['screen', 'plugins', 'agentTask'].includes(id));
  for (const id of mustHave) {
    const routeKey = id === 'forge' ? 'forge' : id;
    assert.ok(
      ROUTES.includes(`${routeKey}:`) || ROUTES.includes(`'${routeKey}'`),
      `桌面扩展路由缺 ${id}`
    );
  }
});

test('桌面扩展路由表与手机 Stack.Screen 一一对应（除系统能力项）', () => {
  const mobileScreens = [...MOBILE_STACK.matchAll(/Stack\.Screen name="ext-([a-zA-Z]+)"/g)].map(m => m[1]);
  assert.ok(mobileScreens.length >= 12, '手机 Stack 注册数量异常');
  // ext-home 是首页本身，不需要「路由」。
  const expected = mobileScreens.filter(id => !['home', 'screen', 'plugins', 'agent-task'].includes(id));
  for (const id of expected) {
    assert.ok(ROUTES.includes(`${id}:`), `桌面路由缺 ${id}（手机有 ext-${id}）`);
  }
});

test('扩展页不再把可移植功能标成「暂不支持」', () => {
  // 旧实现：整页只有一个「暂不支持」清单 + CAPABILITIES 灰条。
  assert.equal(
    /CAPABILITIES\[entry\.id\] === true/.test(EXT_SCREEN),
    false,
    '不应再用能力位把可移植功能标成不可用'
  );
  // 新实现：按手机分组渲染入口，点击交给宿主路由。
  for (const group of ['create', 'companion', 'library', 'games']) {
    assert.ok(EXT_SCREEN.includes(`id: '${group}'`), `扩展页缺分组 ${group}`);
  }
  assert.ok(EXT_SCREEN.includes('onOpen'), '扩展页未把入口点击交给宿主');
  assert.ok(EXT_SCREEN.includes('ext.home.'), '扩展页未复用手机的词条');
});

test('「不可用」清单只含真正依赖系统能力的项', () => {
  // 这些是核对过依赖确实不可移植的：截屏授权 / 插件运行时 / Headless 后台 /
  // llama.cpp 原生库 / 受限 shell。
  const expected = ['screenWatch', 'plugins', 'scheduledTasks', 'localModels', 'workspaceTools'];
  for (const id of expected) {
    assert.ok(REASONS.includes(`${id}: '`), `不可用原因缺 ${id}`);
  }
  // 已实现的功能绝不能出现在不可用清单里（写错了会自相矛盾）。
  for (const id of ['schedule', 'diary', 'moments', 'music', 'books', 'map', 'games', 'forge', 'image', 'proactive']) {
    assert.equal(
      new RegExp(`^\\s*${id}: '`, 'm').test(REASONS),
      false,
      `${id} 已实现，不应出现在不可用清单`
    );
  }
});

test('每个扩展子页面都真实存在且渲染（不是空壳）', () => {
  const routeImports = [...ROUTES.matchAll(/import (\w+) from '\.\/screens\/(\w+)\.jsx'/g)];
  assert.ok(routeImports.length >= 10, `扩展子页面数量异常：${routeImports.length}`);
  for (const [, , file] of routeImports) {
    const source = read(DESKTOP, 'src', 'extension', 'screens', `${file}.jsx`);
    // 必须真的返回 JSX（有 return 与至少一个标签）。
    assert.ok(/return \(/.test(source), `${file} 没有返回 JSX`);
    // 必须复用共享层（不得在桌面重写存储/判定逻辑）。
    assert.ok(
      /from '\.\.\/\.\.\/\.\.\/\.\.\/src\//.test(source),
      `${file} 没有复用共享层模块`
    );
  }
});

test('已实现的扩展页都接了「读失败不覆盖」的共享存储入口', () => {
  // 每个页面都必须通过共享层的 storage/* 读写，不能自己碰 AsyncStorage
  //（否则会绕过损坏保护与串行队列）。
  const screens = ['ScheduleScreen', 'DiaryScreen', 'MomentsScreen', 'ProactiveScreen',
    'MusicScreen', 'BooksScreen', 'MapScreen', 'CardForgeScreen', 'ImageGenScreen'];
  for (const file of screens) {
    const source = read(DESKTOP, 'src', 'extension', 'screens', `${file}.jsx`);
    assert.equal(
      /from '@react-native-async-storage/.test(source),
      false,
      `${file} 不应直接使用 AsyncStorage`
    );
  }
});