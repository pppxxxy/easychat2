// `@expo/vector-icons` 的 Node 端桩。
//
// 真实实现是字体图标：依赖 expo-font 在运行时加载 .ttf，Node 里既没有字体也没有原生绑定。
// 渲染测试关心的是「图标有没有按 name/color/size 被渲染出来」，不是字形，所以桩把
// 每个图标集投影成一个**宿主节点**，把 name/size/color 作为 prop 保留，
// 于是 `root.findAllByType(Ionicons)[0].props.name === 'close'` 这类断言照常可写。
//
// ⚠️ 每个图标集必须是**不同组件**（Ionicons ≠ MaterialIcons），不能共用一个——
// 否则「换了图标集」这种改动在测试里不可见。
//
// 子路径导入（`@expo/vector-icons/Ionicons`）由 setup.mjs 统一映射到本文件，
// 因此这里必须把每个图标集**同时**作为具名导出和 default 暴露：
// 具名给 `import { Ionicons } from '@expo/vector-icons'`，
// default 给 `import Ionicons from '@expo/vector-icons/Ionicons'`（取 Ionicons）。

import React from 'react';

function makeIconSet(displayName) {
  const IconSet = React.forwardRef(function MockIcon(props, ref) {
    return React.createElement(displayName, { ...props, ref });
  });
  IconSet.displayName = `MockIcon(${displayName})`;
  // 真实图标集也挂这两个静态成员，调用方会用到（拿字形表 / 字体名）
  IconSet.glyphMap = {};
  IconSet.font = { fontFamily: displayName };
  return IconSet;
}

const Ionicons = makeIconSet('Ionicons');
const MaterialIcons = makeIconSet('MaterialIcons');
const MaterialCommunityIcons = makeIconSet('MaterialCommunityIcons');
const FontAwesome = makeIconSet('FontAwesome');
const FontAwesome5 = makeIconSet('FontAwesome5');
const FontAwesome6 = makeIconSet('FontAwesome6');
const Feather = makeIconSet('Feather');
const EvilIcons = makeIconSet('EvilIcons');
const Entypo = makeIconSet('Entypo');
const AntDesign = makeIconSet('AntDesign');
const Octicons = makeIconSet('Octicons');
const SimpleLineIcons = makeIconSet('SimpleLineIcons');
const Zocial = makeIconSet('Zocial');
const Foundation = makeIconSet('Foundation');

export {
  Ionicons,
  MaterialIcons,
  MaterialCommunityIcons,
  FontAwesome,
  FontAwesome5,
  FontAwesome6,
  Feather,
  EvilIcons,
  Entypo,
  AntDesign,
  Octicons,
  SimpleLineIcons,
  Zocial,
  Foundation,
};

// 子路径导入一律取 Ionicons 为 default：仓库只用 Ionicons 这一族。
export default Ionicons;
