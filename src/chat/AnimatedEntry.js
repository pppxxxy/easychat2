// 消息入场动画包装器：新消息挂载时从底部淡入滑出。
// enabled 由「距列表底部距离」决定：列表变短时早期消息会重新纳入动画范围，
// effect 必须依赖 enabled，否则该场景下动画从未启动、opacity 停在 0，消息永远不可见。

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

export default function AnimatedEntry({ children, delay = 0, enabled = true, style, onLayout }) {
  const translateY = useRef(new Animated.Value(14)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!enabled) return undefined;
    const animation = Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 320,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 240,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [enabled, delay, translateY, opacity]);

  if (!enabled) {
    return (
      <View style={style} onLayout={onLayout}>
        {children}
      </View>
    );
  }

  return (
    <Animated.View style={[{ opacity, transform: [{ translateY }] }, style]} onLayout={onLayout}>
      {children}
    </Animated.View>
  );
}
