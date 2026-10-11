// 消息列表虚拟化（ScrollView → FlatList）的结构守卫。
//
// 分工：定位算术（按 id 找下标 / 越界守卫 / 未测量项兜底落点 / 重试预算）由
// tests/messageScroll.test.mjs 做**行为**测试；这里只钉「改造中真实踩到、且漏了就静默
// 失效」的接线回归——按仓库约定，源码字符串断言只用于已修复的回归，不用于新功能。
//
// 每条断言对应的失效模式（都是「界面看着正常、功能悄悄没了」那一类）：
//   1. 逐条 onLayout 偏移缓存回归 → 虚拟化窗口外的项没有 onLayout，缓存必然缺值，
//      定位会读到 undefined 然后什么都不做（搜索命中/引用跳转静默失效）；
//   2. FlatList ref 上调用 scrollTo({ y }) → VirtualizedList 只暴露 scrollToOffset /
//      scrollToIndex / scrollToEnd，可选链会让它变成空操作（「跳到开头」按钮失效）；
//   3. 给消息列表加 getItemLayout → 消息高度可变（长文/图片/WebView），写死高度会让
//      scrollToIndex 的落点整体错位；
//   4. keyExtractor 用 index → 窗口扩窗/删除消息后 React 复用错元素，气泡串位；
//   5. scrollToIndex 没有 onScrollToIndexFailed → 未测量项上框架会直接 invariant 抛错。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const MESSAGE_LIST = read('src/chat/MessageList.js');
const CHAT_SCREEN = read('src/ChatScreen.js');
const SCROLL_SCRUBBER_HOOK = read('src/chat/useScrollScrubber.js');

test('回归：逐条偏移缓存与 onLayout 测量不得回归（虚拟化下必然缺值）', () => {
  // 演进链：逐条 onLayout 累积 messageOffsetsRef（ScrollView 时代的定位方式）→
  // FlatList 虚拟化后改走 scrollToIndex。窗口外的项没有 onLayout，缓存里永远缺值，
  // 而缺值时的分支是「什么都不做」——搜索/引用跳转会静默失效。
  assert.equal(MESSAGE_LIST.includes('onMessageLayout'), false, '逐条 onLayout 测量不得回归');
  assert.equal(MESSAGE_LIST.includes('nativeEvent.layout.y'), false, '读取 layout.y 当偏移不得回归');
  // 只认「真的用了」的写法（声明/读写 .current）：注释里提到这个名字是说明演进链，不算回归
  assert.equal(/messageOffsetsRef\s*=\s*useRef/.test(CHAT_SCREEN), false, 'messageOffsetsRef 不得回归');
  assert.equal(/messageOffsetsRef\.current/.test(CHAT_SCREEN), false, '不得再读写偏移缓存');
  assert.equal(CHAT_SCREEN.includes('const onMessageLayout'), false, 'onMessageLayout 不得回归');
  assert.equal(/messageOffsetsRef\.current/.test(SCROLL_SCRUBBER_HOOK), false, '滚动条不得再读偏移缓存');
});

test('回归：列表容器上不得调用 scrollTo（FlatList ref 没有这个方法）', () => {
  // VirtualizedList 暴露 scrollToOffset / scrollToIndex / scrollToEnd / getScrollResponder，
  // 没有 scrollTo。写成 scrollRef.current?.scrollTo?.({ y }) 会静默变成空操作。
  assert.equal(SCROLL_SCRUBBER_HOOK.includes('scrollTo?.'), false, '滚动条「跳到开头」不得再用 scrollTo');
  assert.ok(SCROLL_SCRUBBER_HOOK.includes('scrollToOffset?.({ offset: 0'), '应改用 scrollToOffset');
  assert.equal(CHAT_SCREEN.includes('scrollRef.current?.scrollTo?.('), false, 'ChatScreen 不得再用 scrollTo');
});

test('回归：不给可变高度的消息列表提供 getItemLayout', () => {
  assert.equal(MESSAGE_LIST.includes('getItemLayout={'), false, '消息高度可变，写死 getItemLayout 会错位');
  assert.ok(MESSAGE_LIST.includes('onScrollToIndexFailed={onScrollToIndexFailed}'), '必须有失败兜底');
  assert.ok(MESSAGE_LIST.includes('scrollToIndex'), '定位走 scrollToIndex');
});

test('虚拟化接线：FlatList 承载窗口数据，keyExtractor 用消息 id', () => {
  assert.ok(MESSAGE_LIST.includes('} from \'react-native\';'), '应从 react-native 取组件');
  assert.ok(MESSAGE_LIST.includes('FlatList,'), '滚动容器是 FlatList');
  assert.ok(MESSAGE_LIST.includes('data={visibleMessages}'), '数据是窗口化后的尾部消息');
  assert.ok(MESSAGE_LIST.includes('keyExtractor={keyExtractor}'), 'keyExtractor 走具名函数');
  assert.ok(MESSAGE_LIST.includes('const keyExtractor = message => String((message && message.id) || \'\');'));
  assert.equal(/keyExtractor=\{[^}]*index/.test(MESSAGE_LIST), false, 'keyExtractor 不得用 index');
  // 定位入口由 ref 暴露给 ChatScreen（搜索/引用/滚动条共用）
  assert.ok(MESSAGE_LIST.includes('React.forwardRef'), 'MessageList 需暴露定位句柄');
  assert.ok(MESSAGE_LIST.includes('useImperativeHandle'), '定位入口经 imperative handle 暴露');
  assert.ok(CHAT_SCREEN.includes('ref={ messageListRef }'), 'ChatScreen 必须挂上定位句柄');
  assert.ok(CHAT_SCREEN.includes('messageListRef.current?.scrollToMessage?.(id) === true'), '定位失败要能识别出来');
});

test('虚拟化不改变既有能力：贴底、滚动事件、窗口化入口、空态都在', () => {
  // 自动贴底仍靠 onContentSizeChange（**不**改成 inverted：全链路依赖都在非 inverted 语义上）
  assert.ok(MESSAGE_LIST.includes('onContentSizeChange={autoScrollToBottom}'), '追加消息的自动贴底保留');
  assert.ok(MESSAGE_LIST.includes('onScroll={onMessagesScroll}'), '贴底判定依赖的滚动事件保留');
  assert.equal(MESSAGE_LIST.includes('inverted'), false, '未改成 inverted（贴底语义会整体翻转）');
  // 窗口化（数据层）与虚拟化（挂载层）是两层，窗口入口不能丢
  assert.ok(MESSAGE_LIST.includes('renderedMessages.slice(totalCount - windowSize)'), '尾部窗口保留');
  assert.ok(MESSAGE_LIST.includes('onPress={() => onExpandWindow()}'), '「加载更早消息」保留');
  assert.ok(MESSAGE_LIST.includes('ListHeaderComponent={listHeader}'), '列表头（扩窗入口/根分叉）保留');
  assert.ok(MESSAGE_LIST.includes('ListEmptyComponent={listEmpty}'), '空态改由 ListEmptyComponent 承载');
  assert.ok(MESSAGE_LIST.includes('removeClippedSubviews={false}'), '富文本 WebView 保留原生视图');
});
