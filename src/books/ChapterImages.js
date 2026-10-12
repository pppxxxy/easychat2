import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';

// 章节多图：横向分页浏览，底部圆点指示 + 当前页说明。
export default function ChapterImages({ images = [], height = 200, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const scrollRef = useRef(null);
  // 必须在 hooks **之前**归一：effect 的依赖数组会在渲染阶段求值，images=null 时
  // `images.length` 直接抛 TypeError，下面那行 `if (!images || ...)` 的守卫永远救不了
  // （守卫写了但形状不对）。Array.isArray 兜底与 ChapterSections.js:11 / ChapterNotice.js:14 同形。
  const list = Array.isArray(images) ? images : [];

  useEffect(() => {
    setIndex(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [list.length, list[0] && list[0].source]);

  if (list.length === 0) return null;
  const safeIndex = Math.min(Math.max(index, 0), list.length - 1);

  const onMomentumScrollEnd = event => {
    if (width <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setIndex(Math.max(0, Math.min(next, list.length - 1)));
  };

  return (
    <View style={[styles.wrap, style]}>
      <View
        style={styles.viewport}
        onLayout={event => setWidth(event.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onMomentumScrollEnd}
            scrollEventThrottle={16}
          >
            {list.map((item, itemIndex) => (
              <View key={`page-${itemIndex}`} style={[styles.page, { width }]}>
                <Image source={item.source} style={[styles.image, { height }]} resizeMode="contain" />
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>
      {list.length > 1 ? (
        <View style={styles.dots}>
          {list.map((item, itemIndex) => (
            <View
              key={`dot-${itemIndex}`}
              style={[styles.dot, itemIndex === safeIndex && styles.dotActive]}
            />
          ))}
        </View>
      ) : null}
      {list[safeIndex] && list[safeIndex].caption ? (
        <Text style={styles.caption}>{list[safeIndex].caption}</Text>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: { marginBottom: tokens.spacing.md },
  viewport: { width: '100%' },
  page: { alignItems: 'center', justifyContent: 'center' },
  image: {
    width: '100%',
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dots: { flexDirection: 'row', justifyContent: 'center', marginTop: tokens.spacing.sm },
  dot: {
    width: 6,
    height: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surfaceBorder,
    marginHorizontal: 3,
  },
  dotActive: { backgroundColor: theme.colors.primary, width: 16 },
  caption: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: tokens.spacing.xs,
    textAlign: 'center',
  },
});
