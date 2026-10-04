// 扩展页第四轮审查（2026-10-02）修复的行为固定。
//
// 这批修复是 UI / 原生交互（物理返回、自动滚动、弹层动画），Node 环境无法渲染验证；
// 按仓库约定用源码断言钉住关键结构，防止后续重构把修复无声改回去。
// 同类先例：tests/chatScreenSplit.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const EXTENSION = read('src/ExtensionScreen.js');
const CARD_FORGE = read('src/CardForgeScreen.js');
const IMAGE_GEN = read('src/ImageGenScreen.js');
const ATTACHMENTS = read('src/chat/attachments.js');

test('扩展页：物理返回在子板块 / 游戏详情 / 展开分组内逐级回落', () => {
  assert.ok(EXTENSION.includes("import { useFocusEffect, useNavigation } from '@react-navigation/native';"));
  assert.ok(EXTENSION.includes('BackHandler,'));
  assert.ok(EXTENSION.includes("const SUB_SEGMENT_IDS = ['moments', 'music', 'books', 'screen'];"));
  // 三处兜底：子板块回世界页、游戏详情回列表、展开的分组收起
  assert.equal((EXTENSION.match(/hardwareBackPress/g) || []).length, 3, '应恰好三处返回兜底');
  assert.ok(EXTENSION.includes('if (!SUB_SEGMENT_IDS.includes(segment)) return undefined;'));
  assert.ok(EXTENSION.includes('if (!activeGameId) return undefined;'));
  assert.ok(EXTENSION.includes('if (!openSection) return undefined;'));
  // 注册挂在 useFocusEffect 上：失焦/卸载即注销，避免在其它 Tab 误拦截返回键
  assert.equal((EXTENSION.match(/subscription\.remove\(\)/g) || []).length, 3);
  assert.equal((EXTENSION.match(/return true;/g) || []).length, 3, '处理函数必须消费返回事件');
});

test('扩展页：进入子板块时高亮父级「世界」', () => {
  // 分段条只有 4 个一级入口，子板块（音乐/读书/…）不再是整排无高亮的装饰
  assert.ok(EXTENSION.includes("item.id === 'world' && SUB_SEGMENT_IDS.includes(segment)"));
});

test('制卡：新内容只在接近底部时自动跟滚，用户发送强制跟随', () => {
  assert.ok(CARD_FORGE.includes("import { NEAR_BOTTOM_THRESHOLD } from './chat/chatConstants.js';"));
  assert.ok(CARD_FORGE.includes('const atBottomRef = useRef(true);'));
  assert.ok(CARD_FORGE.includes('atBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;'));
  assert.ok(CARD_FORGE.includes('onScroll={handleScroll}'));
  assert.ok(CARD_FORGE.includes('scrollEventThrottle={16}'));
  assert.ok(CARD_FORGE.includes('if (atBottomRef.current && scrollRef.current) scrollRef.current.scrollToEnd({ animated: true });'));
  // 用户发送：先置底再发（与聊天页一致），保证自己的消息一定可见
  assert.match(CARD_FORGE, /atBottomRef\.current = true;\s*\n\s*busyRef\.current = true;/);
  // 无条件的 scrollToEnd 不再存在
  assert.equal(CARD_FORGE.includes('if (scrollRef.current) scrollRef.current.scrollToEnd'), false);
});

test('生图：底部弹层用 slide 动画；尺寸助手与聊天附件共用一份', () => {
  assert.equal((IMAGE_GEN.match(/animationType="slide"/g) || []).length, 3, '三个底部弹层都应为 slide');
  assert.equal(IMAGE_GEN.includes('animationType="fade"'), false);
  // getImageDimensions 去重：不再本地实现，改用 chat/attachments.js 的导出
  assert.equal(IMAGE_GEN.includes('function getImageDimensions('), false);
  assert.ok(IMAGE_GEN.includes("import { getImageDimensions } from './chat/attachments.js';"));
  assert.ok(ATTACHMENTS.includes('export function getImageDimensions('));
});
