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

const EXTENSION = read('src/extension/ExtensionStack.js');
const EXTENSION_HOME = read('src/extension/ExtensionHome.js');
const CARD_FORGE = read('src/CardForgeScreen.js');
const IMAGE_GEN = read('src/ImageGenScreen.js');
const ATTACHMENTS = read('src/chat/attachments.js');

test('扩展页：嵌套 native-stack 替换 opacity 叠罗汉，物理返回天然工作', () => {
  // 不再手工模拟页面切换：segment 状态机、3 处 BackHandler 补丁、pane 样式全部删除。
  assert.ok(EXTENSION.includes("createNativeStackNavigator"), '使用 native-stack');
  assert.ok(EXTENSION.includes("headerShown: false"));
  assert.ok(EXTENSION.includes("name=\"ext-home\""), '首页注册');
  assert.ok(EXTENSION.includes("name=\"ext-forge\""), '制卡注册');
  assert.ok(EXTENSION.includes("name=\"ext-music\""), '音乐注册');
  assert.equal(EXTENSION.includes('BackHandler'), false, '不再有 BackHandler 补丁');
  assert.equal(EXTENSION.includes('paneVisible'), false, '不再有 opacity 叠罗汉');
  assert.equal(EXTENSION.includes('SUB_SEGMENT_IDS'), false, '不再有路由表');
  assert.equal(EXTENSION.includes('hardwareBackPress'), false, '不再手工拦截返回键');
});

test('扩展页：首页所有入口同行为（navigate），消灭跳出 vs 手风琴二义性', () => {
  assert.ok(EXTENSION_HOME.includes('navigation.navigate('), '首页统一用 navigate');
  assert.equal(EXTENSION_HOME.includes('setSegment'), false, '不再有 segment 状态机');
  assert.equal(EXTENSION_HOME.includes('openSection'), false, '不再有手风琴展开状态');
  assert.equal(EXTENSION_HOME.includes('jumpsOut'), false, '不再有跳出/展开二义标记');
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
  assert.match(IMAGE_GEN, /import \{[^}]*getImageDimensions[^}]*\} from '\.\/chat\/attachments\.js';/);
  assert.ok(ATTACHMENTS.includes('export function getImageDimensions('));
  // 拍照参考图：复用聊天附件的 takePhoto，不自行直连 expo-image-picker
  assert.match(IMAGE_GEN, /import \{[^}]*takePhoto[^}]*\} from '\.\/chat\/attachments\.js';/);
});
