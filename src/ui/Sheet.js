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
//
// ⚠️ R6 结构纪律（Android 手势，2026-10-13 实测回归）：**滚动列表（ScrollView/
// FlatList）不得作为 dismiss 背景 Pressable 的后代**。Android 上背景 Pressable 认领
// responder 且拒绝让渡，卡片内的原生列表收不到触摸流——滚不动、轻点还会误关（点击
// 类控件树更深反而能赢手势，所以症状是「点击正常、拖动全灭」）。底部带列表的面板
// 用 dismissArea="above"：关闭手势只落在卡片**上方**的空白条上，卡片不再是 Pressable
// 的后代。居中卡片类弹窗无滚动需求，维持默认 'wrap'（16 个既有弹窗结构逐字节不变）。

import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';

import SheetHeader from './SheetHeader.js';
import { resolveSheetBackdrop, resolveSheetDismissArea, resolveSheetHeaderKind } from './sheetLayout.js';

// 卡片吞掉按压缩放（等价于改造前 TouchableOpacity 的 activeOpacity={1} + 空 onPress：
// 点卡片不该穿透到背景层把弹窗关掉）。模块级常量：避免每次渲染换引用。
const absorbPress = () => {};
// 'above' 结构里关闭条的样式（模块级常量，同上）。
const dismissFill = { flex: 1 };

export default function Sheet({
  visible,
  onClose,
  animationType = 'fade',
  // 'dismiss'（点空白关闭，默认）| 'static'（点空白不关闭）| 'keyboard'（键盘抬升）
  backdropMode = 'dismiss',
  // R6：dismiss 手势的落点——'wrap'（默认，背景包卡片；无滚动需求的弹窗用）
  // 或 'above'（底部面板：点卡片上方空白关闭，卡片内列表可正常滚动）。
  // 只有 dismiss 语义下 'above' 才生效（见 sheetLayout.resolveSheetDismissArea）。
  dismissArea = 'wrap',
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
  const area = resolveSheetDismissArea({ backdrop, dismissArea });
  const Backdrop = backdrop.keyboardAvoiding
    ? KeyboardAvoidingView
    : (backdrop.dismissOnPress ? Pressable : View);
  const Card = cardAbsorbPress ? Pressable : View;
  const headerKind = resolveSheetHeaderKind({ header, title });

  // 卡片只构造一次、两种结构共用：模态无障碍标记因此收在一处（tests/uiSheet.test.mjs
  // 与 chatA11y 钉的就是「标记在卡片开标签里」这条）。
  const card = (
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
  );

  if (area === 'above') {
    // 底部面板：View(flex:1) 纵排 [点它关闭的上方空白条, 卡片]。卡片不是 Pressable 的
    // 后代 → 内部列表滚动恢复；点卡片内空白不误关。
    return (
      <Modal
        visible={visible}
        transparent
        animationType={animationType}
        onRequestClose={onClose}
      >
        <View style={backdropStyle}>
          <Pressable
            style={dismissFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          />
          {card}
        </View>
      </Modal>
    );
  }

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
        {card}
      </Backdrop>
    </Modal>
  );
}
