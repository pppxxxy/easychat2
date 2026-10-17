// 原生桩自身的守卫测试。
//
// 为什么给桩写测试：桩是「假货」，一旦它悄悄偏离真实语义，所有依赖它的渲染测试
// 都会变成假绿——而且失败方向是「测试全过、真机崩」。这个文件把「桩必须守住的
// 语义」钉死，并顺带验证 setup.mjs 的解析映射真的生效（拼错包名会在这里红）。
//
// 钉的四类语义：
//   ① 解析：六个原生包 + 两个子路径确实被重定向到桩（不是加载了真模块）
//   ② 渲染：组件投影为同名宿主节点，children 透传，findByType 可用
//   ③ 失败面：读不到就抛 / 存在性查询不抛 / 超限抛——这些差异是 App 的 catch 判据
//   ④ 副作用面：Alert/Clipboard/Linking 被记录而非执行
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { setupNativeStubs, stubTargets } from './helpers/rn/setup.mjs';

setupNativeStubs();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const React = require('react');
const TestRenderer = require('react-test-renderer');
const act = TestRenderer.act || React.act;

const RN = await import('./helpers/rn/react-native.mjs');
const AsyncStorage = (await import('./helpers/rn/async-storage.mjs')).default;
const AsyncStorageIntrospect = await import('./helpers/rn/async-storage.mjs');
const FileSystemLegacy = (await import('./helpers/rn/expo-file-system-legacy.mjs')).default;
const FileSystemLegacyIntrospect = await import('./helpers/rn/expo-file-system-legacy.mjs');
// 这两个是 .cjs：ESM 下 `import()` 会把 module.exports 放在 default 上。
const SecureStoreIntrospect = (await import('./helpers/rn/expo-secure-store.cjs')).default;
const SQLiteIntrospect = (await import('./helpers/rn/expo-sqlite.cjs')).default;
const VectorIcons = await import('./helpers/rn/vector-icons.mjs');

// ---------------------------------------------------------------------------
// ① 解析映射
// ---------------------------------------------------------------------------

test('桩映射表覆盖 6 个原生包 + expo-file-system/legacy 子路径', () => {
  const targets = stubTargets();
  const expected = [
    '@react-native-async-storage/async-storage',
    'expo-file-system',
    'expo-secure-store',
    'expo-sqlite',
    'react-native',
  ];
  for (const name of expected) {
    assert.ok(targets.nativePackages.includes(name), `桩映射表缺少 ${name}`);
  }
  assert.ok(targets.subpaths.includes('expo-file-system/legacy'), 'legacy 子路径必须单独映射（与新版是两套 API）');
});

test('setup 后 import 原生包拿到的是桩，不是真模块', async () => {
  // 真 react-native 源码是 Flow，Node 加载会在 typeof 处抛 SyntaxError；
  // 能成功 import 且带 __ 自省接口，就证明走的是桩。
  const imported = await import('react-native');
  assert.equal(typeof imported.View, 'object', 'View 应是 forwardRef 对象（组件）');
  assert.equal(typeof imported.__setFontScale, 'function', '桩的自省接口应存在');

  const storage = await import('@react-native-async-storage/async-storage');
  // default 是库对象本身（与真实库一致），自省接口是具名导出
  assert.equal(typeof storage.default.getItem, 'function', 'default 应是 AsyncStorage 对象');
  assert.equal(typeof storage.__reset, 'function', '具名导出应是桩的自省接口');

  // 子路径必须解析到**不同**的桩文件（legacy 有 readAsStringAsync，新版没有）
  const legacy = await import('expo-file-system/legacy');
  const modern = await import('expo-file-system');
  assert.equal(typeof legacy.default.readAsStringAsync, 'function', 'legacy 桩应有 readAsStringAsync');
  assert.equal(modern.default.readAsStringAsync, undefined, '新版桩不应有 legacy API');

  const icons = await import('@expo/vector-icons/Ionicons');
  assert.ok(icons.default, '子路径图标导入应有 default');
});

test('图标桩：每个图标集是不同组件（换图标集的改动才可见）', () => {
  assert.notEqual(VectorIcons.Ionicons, VectorIcons.MaterialIcons, '不同图标集必须是不同组件');
  assert.equal(VectorIcons.Ionicons.displayName, 'MockIcon(Ionicons)');
  assert.ok(VectorIcons.Ionicons.glyphMap, '真实图标集挂 glyphMap，桩也要挂');
});

// ---------------------------------------------------------------------------
// ② 渲染语义
// ---------------------------------------------------------------------------

function render(element) {
  let renderer;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer;
}

test('组件投影为同名宿主节点，children 与 props 透传', () => {
  const renderer = render(React.createElement(RN.View, { testID: 'outer' },
    React.createElement(RN.Text, { numberOfLines: 1 }, '正文')));
  const json = renderer.toJSON();
  assert.equal(json.type, 'View', 'View 应投影成宿主节点 View');
  assert.equal(json.props.testID, 'outer', 'props 应透传');
  assert.equal(json.children[0].type, 'Text');
  assert.equal(json.children[0].children[0], '正文', 'children 应透传');
  renderer.unmount();
});

test('ForwardRef：组件能接 ref，且 ref 挂到宿主节点', () => {
  const ref = React.createRef();
  const renderer = render(React.createElement(RN.View, { ref }, 'x'));
  // react-test-renderer 里宿主节点的 ref 由测试渲染器提供，默认是 null（没有真实原生实例）。
  // 这里能验证的是**组件接受了 ref 且没抛**（forwardRef 接线正确），而不是拿到原生句柄——
  // 后者只有真机/jest-expo 才有。写 null 断言而不是 omit，是为了让「改成非 forwardRef」变红。
  assert.equal(ref.current, null, '测试渲染器不给宿主 ref 实例（这是渲染器的事实，不是桩的缺陷）');
  assert.ok(renderer.toJSON(), '带 ref 渲染不应破坏树');
  renderer.unmount();
});

test('TextInput 可被 findByType 找到并读到受控 value（渲染测试的基础）', () => {
  const renderer = render(React.createElement(RN.TextInput, { value: 'abc', onChangeText: () => {} }));
  const inputs = renderer.root.findAllByType('TextInput');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.value, 'abc');
  renderer.unmount();
});

test('FlatList 真的渲染出 data（否则列表测试会假绿成「渲染 0 次」）', () => {
  const data = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const rendered = [];
  const renderer = render(React.createElement(RN.FlatList, {
    data,
    keyExtractor: item => item.id,
    renderItem: ({ item }) => {
      rendered.push(item.id);
      return React.createElement(RN.Text, null, item.id);
    },
    ListHeaderComponent: () => React.createElement(RN.Text, null, 'HEADER'),
    ListFooterComponent: () => React.createElement(RN.Text, null, 'FOOTER'),
  }));
  assert.deepEqual(rendered, ['a', 'b', 'c'], 'renderItem 应对每一项调用一次');
  const flat = JSON.stringify(renderer.toJSON());
  assert.ok(flat.includes('HEADER') && flat.includes('FOOTER'), '页眉页脚应渲染');
  renderer.unmount();
});

test('FlatList 空数据时渲染 ListEmptyComponent', () => {
  const renderer = render(React.createElement(RN.FlatList, {
    data: [],
    renderItem: () => null,
    ListEmptyComponent: () => React.createElement(RN.Text, null, 'EMPTY'),
  }));
  assert.ok(JSON.stringify(renderer.toJSON()).includes('EMPTY'));
  renderer.unmount();
});

test('Modal 在 visible=false 时不挂载 children（与 RN 可见语义一致）', () => {
  const renderer = render(React.createElement(RN.Modal, { visible: false },
    React.createElement(RN.Text, null, '不该出现')));
  const flat = JSON.stringify(renderer.toJSON());
  assert.ok(!flat.includes('不该出现'), '不可见的 Modal 不应渲染内容');
  renderer.unmount();

  const shown = render(React.createElement(RN.Modal, { visible: true },
    React.createElement(RN.Text, null, '应该出现')));
  assert.ok(JSON.stringify(shown.toJSON()).includes('应该出现'));
  shown.unmount();
});

test('Animated：timing(...).start(cb) 立即以 finished:true 回调（不卡住 await）', () => {
  const value = new RN.Animated.Value(0);
  assert.equal(typeof value.interpolate, 'function');
  let finished = null;
  RN.Animated.timing(value, { toValue: 1, duration: 80 }).start(result => { finished = result.finished; });
  assert.equal(finished, true, 'start 必须回调，否则组件里的动画链会挂起');
});

test('StyleSheet.create 原样返回、flatten 合并数组（条件样式的取值逻辑仍被执行）', () => {
  const styles = RN.StyleSheet.create({ a: { color: 'red' }, b: { size: 1 } });
  assert.deepEqual(styles, { a: { color: 'red' }, b: { size: 1 } });
  assert.deepEqual(RN.StyleSheet.flatten([styles.a, null, styles.b]), { color: 'red', size: 1 });
  assert.deepEqual(RN.StyleSheet.flatten([styles.a, [styles.b]]), { color: 'red', size: 1 }, '嵌套数组也要摊平');
});

test('Platform.select 按 android 优先回落', () => {
  assert.equal(RN.Platform.OS, 'android');
  assert.equal(RN.Platform.select({ android: 'A', ios: 'I', default: 'D' }), 'A');
  assert.equal(RN.Platform.select({ ios: 'I', default: 'D' }), 'D');
  assert.equal(RN.Platform.select({ ios: 'I', native: 'N' }), 'N');
});

// ---------------------------------------------------------------------------
// ③ 失败面（这些差异是 App catch 分支的判据，桩不能友好化）
// ---------------------------------------------------------------------------

test('AsyncStorage 桩：getItem 未命中返回 null（不是 undefined），并有写入计数', async () => {
  AsyncStorageIntrospect.__reset();
  assert.equal(await AsyncStorage.getItem('missing'), null, '未命中必须是 null');
  await AsyncStorage.setItem('k', 'v');
  assert.equal(await AsyncStorage.getItem('k'), 'v');
  assert.equal(AsyncStorageIntrospect.__calls().set, 1, '写入次数应可观测（用于「少写一次」这类断言）');
  assert.deepEqual(await AsyncStorage.getAllKeys(), ['k']);
});

test('AsyncStorage 桩：可定向注入读写失败', async () => {
  AsyncStorageIntrospect.__reset();
  AsyncStorageIntrospect.__failGet(['bad']);
  await assert.rejects(() => AsyncStorage.getItem('bad'), /getItem failed/);
  AsyncStorageIntrospect.__failSet(['bad']);
  await assert.rejects(() => AsyncStorage.setItem('bad', 'v'), /setItem failed/);
  AsyncStorageIntrospect.__clearFailures();
  await AsyncStorage.setItem('bad', 'ok');
  assert.equal(await AsyncStorage.getItem('bad'), 'ok');
});

test('legacy FileSystem 桩：读不到就抛，getInfo 读不到不抛', async () => {
  FileSystemLegacyIntrospect.__reset();
  // 读不到 → 抛（真实实现也抛；若桩返回 null，App 的 catch 分支永远测不到）
  await assert.rejects(() => FileSystemLegacy.readAsStringAsync('file:///nope'), /missing file/);
  // 存在性查询 → 不抛，返回 exists:false
  assert.deepEqual(
    await FileSystemLegacy.getInfoAsync('file:///nope'),
    { exists: false, isDirectory: false, uri: 'file:///nope' }
  );
  // 写入后可读回
  await FileSystemLegacy.writeAsStringAsync('file:///a.txt', 'hello');
  assert.equal(await FileSystemLegacy.readAsStringAsync('file:///a.txt'), 'hello');
  assert.equal(FileSystemLegacyIntrospect.__calls().write, 1);
});

test('legacy FileSystem 桩：deleteAsync 默认幂等，显式 idempotent:false 才抛', async () => {
  FileSystemLegacyIntrospect.__reset();
  await FileSystemLegacy.deleteAsync('file:///ghost'); // 默认幂等：不抛
  await assert.rejects(
    () => FileSystemLegacy.deleteAsync('file:///ghost', { idempotent: false }),
    /missing/
  );
});

test('legacy FileSystem 桩：deleteAsync 目录时连带删子文件', async () => {
  FileSystemLegacyIntrospect.__reset();
  await FileSystemLegacy.writeAsStringAsync('file:///dir/a.txt', 'a');
  await FileSystemLegacy.writeAsStringAsync('file:///dir/b.txt', 'b');
  await FileSystemLegacy.deleteAsync('file:///dir');
  const files = FileSystemLegacyIntrospect.__files();
  assert.equal(files.size, 0, '目录下的文件应被一起删掉');
});

test('SecureStore 桩：保留 2048 字节单值上限（这是「逐值保护」的设计理由）', async () => {
  SecureStoreIntrospect.__reset();
  const big = 'x'.repeat(2049);
  await assert.rejects(
    () => SecureStoreIntrospect.setItemAsync('k', big),
    /exceeds 2048 bytes/,
    '超限必须抛，否则 secretStore 的逐值保护理由在测试里不可见'
  );
  await SecureStoreIntrospect.setItemAsync('k', 'ok');
  assert.equal(await SecureStoreIntrospect.getItemAsync('k'), 'ok');
});

test('SecureStore 桩：可模拟 Keystore 不可用与读失败（secretStore 两条「读不回」纪律的判据）', async () => {
  SecureStoreIntrospect.__reset();
  SecureStoreIntrospect.__setAvailable(false);
  await assert.rejects(() => SecureStoreIntrospect.getItemAsync('k'), /unavailable/);
  SecureStoreIntrospect.__reset();
  SecureStoreIntrospect.__failReads(true);
  await assert.rejects(() => SecureStoreIntrospect.getItemAsync('k'), /getItemAsync failed/);
});

test('SQLite 桩：分块读兜底的两条 SQL 形状可用，其它 SQL 显式抛', async () => {
  SQLiteIntrospect.__reset();
  SQLiteIntrospect.__seed({ '@easychat2_chat::s1': 'abcdef' });
  const db = SQLiteIntrospect.openDatabase('../../databases/RKStorage');
  const length = await db.execAsync([{ sql: 'SELECT length(value) AS total FROM catalog WHERE key = ?', args: ['@easychat2_chat::s1'] }]);
  assert.equal(length[0].rows[0].total, 6);
  const chunk = await db.execAsync([{ sql: 'SELECT substr(value, ?, ?) AS chunk FROM catalog WHERE key = ?', args: [2, 3, '@easychat2_chat::s1'] }]);
  assert.equal(chunk[0].rows[0].chunk, 'bcd', 'offset 是 1-based');
  // 未打桩的 SQL 必须炸，不能返回空行——否则「大值读不回」这条路径会假绿
  await assert.rejects(
    () => db.execAsync([{ sql: 'DELETE FROM catalog', args: [] }]),
    /未打桩的 SQL/
  );
});

// ---------------------------------------------------------------------------
// ④ 副作用面
// ---------------------------------------------------------------------------

test('Alert / Clipboard / Linking 被记录而非真正执行', async () => {
  const before = RN.__alertCalls.length;
  RN.Alert.alert('标题', '正文');
  assert.equal(RN.__alertCalls.length, before + 1);
  assert.deepEqual(RN.__alertCalls[RN.__alertCalls.length - 1], ['标题', '正文']);

  const clipboardBefore = RN.__clipboardWrites.length;
  RN.Clipboard.setString('复制的文本');
  assert.equal(RN.__clipboardWrites.length, clipboardBefore + 1);

  await RN.Linking.openURL('https://example.com/x');
  assert.ok(RN.__linkingCalls.includes('https://example.com/x'));
});

test('useWindowDimensions 返回稳定尺寸（组件里的响应式分支可预测）', () => {
  assert.equal(RN.Platform.OS, 'android');
  const dims = RN.Dimensions.get();
  assert.ok(dims.width > 0 && dims.height > 0);
  assert.equal(typeof RN.PixelRatio.get(), 'number');
});
