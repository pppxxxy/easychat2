// 拓展 Stack 各子屏的返回栏守卫。
// 背景（2026-10-06 用户报告）：ExtensionStack 化后只有 proactive/diary 接了
// PaneHeader，其余 8 个子屏（游戏/图像/制卡/动态/屏幕注视/音乐/书籍/世界地图）
// 的可视返回键整体丢失——物理返回虽然能用，但界面 affordance 没了。
// 本守卫钉住：8 个子屏必须 import PaneHeader 并在渲染里接 onBack（goBack）；
// 拓展首页是 Tab 根（无可返回目标），按记忆页/设置页惯例有标题栏即可。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments) => readFileSync(path.join(HERE, '..', 'src', ...segments), 'utf8');

const STACK_SCREENS = [
  ['extension/GamesView.js', 'ext.home.games'],
  ['ImageGenScreen.js', 'ext.home.image'],
  ['CardForgeScreen.js', 'forge.screen.title'],
  ['MomentsView.js', 'moments.title'],
  ['screenWatch/ScreenWatchScreen.js', 'screenWatch.title'],
  ['music/MusicScreen.js', 'music.title'],
  ['books/BookScreen.js', 'books.title'],
  ['MapPanel.js', 'map.title'],
];

test('拓展 Stack 的 8 个子屏都必须有 PaneHeader 返回栏（标题 + goBack）', () => {
  for (const [file, titleKey] of STACK_SCREENS) {
    const source = read(file);
    assert.ok(
      source.includes("from '../ui/PaneHeader.js'") || source.includes("from './ui/PaneHeader.js'"),
      `${file} 未引入 PaneHeader`
    );
    assert.ok(source.includes('useNavigation'), `${file} 应持有 navigation`);
    assert.ok(source.includes('navigation.goBack()'), `${file} 缺 goBack 返回`);
    // 边界锚定：裸 '<PaneHeader' 会被 <PaneHeaderX 之类误命中（substring 陷阱）
    assert.ok(/<PaneHeader[\s>]/.test(source), `${file} 未渲染 PaneHeader`);
    assert.ok(source.includes(titleKey), `${file} 返回栏标题键应为 ${titleKey}`);
  }
});

test('拓展首页是 Tab 根：有标题栏，不放指向空处的返回键', () => {
  const home = read('extension/ExtensionHome.js');
  assert.ok(home.includes("t('app.tab.extension')"), '首页应有标题（扩展）');
  assert.ok(!home.includes('goBack'), '栈根没有可弹出的页面，不应放返回键');
});

test('PaneHeader 本体保留返回 affordance（图标 + 文案）', () => {
  const header = read('ui/PaneHeader.js');
  assert.ok(header.includes('chevron-back'));
  assert.ok(header.includes('ext.world.back'));
});
