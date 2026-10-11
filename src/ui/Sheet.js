// 共享弹窗外壳：透明 Modal + 背景层 + 卡片 + 可选 SheetHeader + 模态无障碍标记。
//
// 背景：聊天页的 16 个 *Modal.js 各写一遍「透明 Modal + animationType="fade" +
// TouchableOpacity/Pressable 背景 + sheet 容器 + accessibilityViewIsModal +
// importantForAccessibility="yes"」——同一套外壳复制 16 份，模态无障碍标记还漏过一轮
//（0/16，见 tests/chatA11y.test.mjs 钉的回归）。这里把外壳收成一处。
//
// **不统一视觉**：圆角/背景/内边距/最大高度/滚动容器仍由调用方通过 backdropStyle /
// cardStyle 传入。这些参数各弹窗本来就不同（居中卡片 70% 高 / 右上角菜单 / 底部面板
// 72% 高 / 键盘抬升），统一它们等于改设计。
//
// 不改 Modal 的 visible 语义：**始终**渲染 <Modal visible={visible}>，不写
// `visible ? <Modal/> : null`。RN 的 Modal 在 visible=false 时自己返回 null
//（Modal.js:286-289），但 iOS 关闭动画期间靠 state.isRendered 继续渲染内容
//（Modal.js:278-284）——外面再判一次 visible 会让关闭动画直接闪没。

import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';

import SheetHeader from './SheetHeader.js';
import { resolveSheetBackdrop, resolveSheetHeaderKind } from './sheetLayout.js';

// 卡片吞掉按压缩放（等价于改造前 TouchableOpacity 的 activeOpacity={1} + 空 onPress：
// 点卡片不该穿透到背景层把弹窗关掉）。模块级常量：避免每次渲染换引用。
const absorbPress = () => {};

export default function Sheet({
  visible,
  onClose,
  animationType = 'fade',
  // 'dismiss'（点空白关闭，默认）| 'static'（点空白不关闭）| 'keyboard'（键盘抬升）
  backdropMode = 'dismiss',
  backdropStyle,
  cardStyle,
  // 卡片是否需要吞掉点击（改造前用 TouchableOpacity 当卡片的弹窗需要）
  cardAbsorbPress = false,
  // 头部：header 节点优先；只给 title 时用共享 SheetHeader。
  header = null,
  title,
  onBack,
  closeLabel,
  children,
}) {
  const backdrop = resolveSheetBackdrop(backdropMode);
  const Backdrop = backdrop.keyboardAvoiding
    ? KeyboardAvoidingView
    : (backdrop.dismissOnPress ? Pressable : View);
  const Card = cardAbsorbPress ? Pressable : View;
  const headerKind = resolveSheetHeaderKind({ header, title });

  return (
    <Modal
      visible={visible}
      transparent
      animationType={animationType}
      onRequestClose={onClose}
    >
      <Backdrop
        style={backdropStyle}
        {...(backdrop.dismissOnPress ? { onPress: onClose } : null)}
        {...(backdrop.keyboardAvoiding
          ? { behavior: Platform.OS === 'ios' ? 'padding' : undefined }
          : null)}
      >
        <Card
          style={cardStyle}
          {...(cardAbsorbPress ? { onPress: absorbPress } : null)}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          {headerKind === 'custom' ? header : null}
          {headerKind === 'standard' ? (
            <SheetHeader title={title} onClose={onClose} onBack={onBack} closeLabel={closeLabel} />
          ) : null}
          {children}
        </Card>
      </Backdrop>
    </Modal>
  );
}
