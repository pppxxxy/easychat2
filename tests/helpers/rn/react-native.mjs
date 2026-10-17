// `react-native` 的 Node 端桩：只为「在 Node 里渲染真实 RN 组件」提供最小可渲染实现。
//
// 为什么必须有它：真实 `react-native` 的源码是 Flow + JSX，且入口依赖 TurboModule
// 原生绑定。Node 直接 import 会在 `Unexpected token 'typeof'` 处炸掉。
// 这个桩把每个组件投影成一个**同名宿主节点**（`View` → 宿主 'View'），于是
// react-test-renderer 能真实挂载整棵树、真实触发 useState/useEffect/useMemo，
// 而 `root.findByType(TextInput)` 这类查询照常可用。
//
// 边界（必须诚实）：这是**渲染语义**的桩，不是布局引擎。
// 它不计算样式、不做 measure、不产生原生事件；`Animated` 只保留可调用的形状。
// 因此它验证不了「像素对不对」，只能验证「组件逻辑与渲染次数对不对」。

import React from 'react';

function makeComponent(displayName) {
  const Component = React.forwardRef(function Mock(props, ref) {
    const { children, ...rest } = props;
    return React.createElement(displayName, { ...rest, ref }, children);
  });
  Component.displayName = `Mock(${displayName})`;
  return Component;
}

const NAMES = [
  'ActivityIndicator',
  'Button',
  'DrawerLayoutAndroid',
  'Image',
  'ImageBackground',
  'KeyboardAvoidingView',
  'Pressable',
  'ScrollView',
  'Switch',
  'Text',
  'TextInput',
  'TouchableHighlight',
  'TouchableNativeFeedback',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
  'View',
  'VirtualizedList',
];

const components = {};
for (const name of NAMES) components[name] = makeComponent(name);

// 逐个解构成具名常量，供文件末尾的 export 列表使用（RN 里这些都是具名导出）。
const {
  ActivityIndicator,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableHighlight,
  TouchableNativeFeedback,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  VirtualizedList,
} = components;

// FlatList/SectionList 必须真的把数据渲染出来，否则列表类组件的渲染测试会得到
// 「子项渲染 0 次」这种假绿。这里做最小渲染：map 出 renderItem 的结果。
function makeList(displayName, Base) {
  const ListComponent = React.forwardRef(function MockList(props, ref) {
    const {
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListFooterComponent,
      ListEmptyComponent,
      children,
      ...rest
    } = props;
    const items = Array.isArray(data) ? data : [];
    const rendered = items.length > 0 && typeof renderItem === 'function'
      ? items.map((item, index) => {
        const key = typeof keyExtractor === 'function'
          ? keyExtractor(item, index)
          : (item && item.key != null ? item.key : String(index));
        return React.createElement(React.Fragment, { key }, renderItem({ item, index, separators: {} }));
      })
      : [];
    const asElement = Value => React.createElement(Value);
    const header = ListHeaderComponent ? asElement(ListHeaderComponent) : null;
    const footer = ListFooterComponent ? asElement(ListFooterComponent) : null;
    const empty = items.length === 0 && ListEmptyComponent ? asElement(ListEmptyComponent) : null;
    return React.createElement(
      Base,
      { ...rest, ref },
      header,
      empty,
      ...rendered,
      footer,
      children
    );
  });
  ListComponent.displayName = `Mock(${displayName})`;
  return ListComponent;
}

components.FlatList = makeList('FlatList', View);
components.SectionList = makeList('SectionList', View);

// Modal：只在 visible !== false 时渲染 children，与 RN 的可见语义一致
// （不可见的 Modal 不挂载内容，测「关闭时不该算渲染」才有意义）。
const Modal = React.forwardRef(function MockModal(props, ref) {
  const { children, visible = true, ...rest } = props;
  return React.createElement('Modal', { ...rest, ref, visible }, visible ? children : null);
});
Modal.displayName = 'Mock(Modal)';
components.Modal = Modal;

const FlatList = components.FlatList;
const SectionList = components.SectionList;

// ---- Animated ----
// 只保留「形状对、可调用」：组件会读 .current、传给 style.transform、调 .start()。
// 不模拟时间轴（没有 ticker），因为渲染测试不依赖动画进度。
class AnimatedValue {
  constructor(value) {
    this._value = value;
  }

  setValue(value) {
    this._value = value;
  }

  interpolate(config) {
    return { __animatedInterpolation: true, config };
  }

  addListener() {
    return '1';
  }

  removeListener() {}

  removeAllListeners() {}

  stopAnimation() {}
}

function makeAnimation() {
  return {
    start: callback => {
      if (typeof callback === 'function') callback({ finished: true });
    },
    stop() {},
    reset() {},
  };
}

const Animated = {
  Value: AnimatedValue,
  ValueXY: AnimatedValue,
  View: makeComponent('Animated.View'),
  Text: makeComponent('Animated.Text'),
  Image: makeComponent('Animated.Image'),
  ScrollView: makeComponent('Animated.ScrollView'),
  FlatList: makeComponent('Animated.FlatList'),
  timing: () => makeAnimation(),
  spring: () => makeAnimation(),
  decay: () => makeAnimation(),
  sequence: () => makeAnimation(),
  parallel: () => makeAnimation(),
  loop: () => makeAnimation(),
  delay: () => makeAnimation(),
  createAnimatedComponent: Component => Component,
  event: () => () => {},
  add: first => first,
  multiply: first => first,
  divide: first => first,
};

// ---- StyleSheet ----
// create 原样返回：样式对象在渲染测试里只是数据（没有布局）。
// 但**数组/条件样式**的取值逻辑仍会被执行，所以样式分支依然被测到。
const StyleSheet = {
  create: styles => styles,
  flatten: style => (Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : (style || {})),
  compose: (first, second) => [first, second],
  hairlineWidth: 0.5,
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
};

// ---- Platform ----
// 取 android 分支（本仓库主目标平台），select 按 RN 的优先级回落。
const Platform = {
  OS: 'android',
  Version: 34,
  isTV: false,
  isTesting: true,
  select: spec => {
    if (spec == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(spec, 'android')) return spec.android;
    if (Object.prototype.hasOwnProperty.call(spec, 'native')) return spec.native;
    return spec.default;
  },
};

// ---- 尺寸 / 像素比 ----
const WINDOW = { width: 400, height: 800, scale: 2, fontScale: 1 };
let fontScale = 1;

const Dimensions = {
  get: () => ({ ...WINDOW, fontScale }),
  addEventListener: () => ({ remove() {} }),
  removeEventListener: () => {},
  set: next => {
    if (next && next.fontScale) fontScale = next.fontScale;
  },
};

const PixelRatio = {
  get: () => WINDOW.scale,
  getFontScale: () => fontScale,
  getPixelSizeForLayoutSize: size => Math.round(size * WINDOW.scale),
  roundToNearestPixel: size => Math.round(size * WINDOW.scale) / WINDOW.scale,
};

function useWindowDimensions() {
  return { ...WINDOW, fontScale };
}

// ---- 副作用类 API：记录调用，不产生真实行为 ----
const alertCalls = [];
const Alert = {
  alert: (...args) => {
    alertCalls.push(args);
  },
};

const linkingCalls = [];
const Linking = {
  openURL: async url => {
    linkingCalls.push(url);
  },
  canOpenURL: async () => true,
  getInitialURL: async () => null,
  addEventListener: () => ({ remove() {} }),
};

const clipboardWrites = [];
const Clipboard = {
  setString: value => {
    clipboardWrites.push(value);
  },
  getString: async () => '',
};

const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove() {} }),
};

const Keyboard = {
  dismiss: () => {},
  addListener: () => ({ remove() {} }),
};

class Emitter {
  addListener() {
    return { remove() {} };
  }

  removeAllListeners() {}

  emit() {}

  removeListener() {}
}

const NativeModules = {};
const AppRegistry = { registerComponent: () => {}, runApplication: () => {} };
const PermissionsAndroid = { request: async () => 'granted', check: async () => true };
const PanResponder = { create: () => ({ panHandlers: {} }) };
const Easing = {
  linear: t => t,
  ease: t => t,
  in: fn => fn,
  out: fn => fn,
  inOut: fn => fn,
  bezier: () => t => t,
};

const DeviceEventEmitter = new Emitter();
const NativeEventEmitter = Emitter;

export {
  ActivityIndicator,
  Alert,
  Animated,
  AppRegistry,
  AppState,
  Clipboard,
  DeviceEventEmitter,
  Dimensions,
  Easing,
  FlatList,
  Image,
  ImageBackground,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeEventEmitter,
  NativeModules,
  PanResponder,
  PermissionsAndroid,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableHighlight,
  TouchableNativeFeedback,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  VirtualizedList,
  useWindowDimensions,
};

// 测试自省（非 RN API，__ 前缀标明）
export const __alertCalls = alertCalls;
export const __linkingCalls = linkingCalls;
export const __clipboardWrites = clipboardWrites;
export const __setFontScale = value => {
  fontScale = value;
};

export default {
  ...components,
  Animated,
  StyleSheet,
  Platform,
  Dimensions,
  PixelRatio,
  useWindowDimensions,
};
