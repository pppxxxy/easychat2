// 消息入场动画包装器：新消息挂载时从底部淡入滑出。
// 仅执行一次（mount 触发），配合 React key 复用机制避免重复动画。

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

export default function AnimatedEntry({ children, delay = 0, enabled = true, style, onLayout }) {
  const translateY = useRef(new Animated.Value(14)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!enabled) return;
    Animated.parallel([
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
    ]).start();
  }, []);

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
