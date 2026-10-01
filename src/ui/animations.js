// 轻量动画工具：基于 React Native Animated API 的可复用动画 Hook。
// 不引入额外依赖，纯 RN 内置能力实现按压、呼吸、滑入效果。

import { useRef, useEffect, useCallback } from 'react';
import { Animated, Easing } from 'react-native';

// 呼吸动画：适合于空状态图标、加载指示器等需要持续吸引注意力的场景。
export function usePulseAnimation({ min = 0.92, max = 1.08, duration = 2000 } = {}) {
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: max,
          duration: duration / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: min,
          duration: duration / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [anim, min, max, duration]);

  return anim;
}

// 按压缩放动画：用于按钮、卡片等可点击元素，提供触觉般的视觉反馈。
export function usePressScale({ scale = 0.96, duration = 100 } = {}) {
  const anim = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.timing(anim, {
      toValue: scale,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, scale, duration]);

  const onPressOut = useCallback(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, duration]);

  return { scale: anim, onPressIn, onPressOut };
}

// 滑入动画：用于列表项、弹窗内容等需要强调「出现」的场景。
export function useSlideIn({ duration = 300, delay = 0, from = 'bottom' } = {}) {
  const translate = useRef(new Animated.Value(from === 'bottom' ? 24 : from === 'top' ? -24 : 0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translate, {
        toValue: 0,
        duration,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: duration * 0.7,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [translate, opacity, duration, delay, from]);

  return { translate, opacity };
}

// Tab 图标缩放动画：用于底部导航栏图标切换时的高亮动效。
export function useTabIconScale(focused) {
  const anim = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: focused ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, focused]);

  const scale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });

  return scale;
}
