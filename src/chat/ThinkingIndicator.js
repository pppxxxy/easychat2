// 思考中指示器。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext';
import { createChatStyles } from './chatStyles';

export default function ThinkingIndicator() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const progress = useRef(null);
  if (progress.current === null) progress.current = new Animated.Value(0);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress.current, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: true,
        isInteraction: false,
      })
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <View style={styles.thinkingIndicator} accessible accessibilityLabel="正在思考" accessibilityRole="text">
      <Text style={styles.thinkingText}>正在思考</Text>
      {[0, 1, 2].map(index => (
        <Animated.View
          key={index}
          style={[
            styles.thinkingDot,
            {
              opacity: progress.current.interpolate({
                inputRange: [0, 0.15 + index * 0.2, 0.35 + index * 0.2, 1],
                outputRange: [0.25, 1, 0.25, 0.25],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}
