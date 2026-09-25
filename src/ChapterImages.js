import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from './theme/ThemeContext';

// 章节多图：横向分页浏览，底部圆点指示 + 当前页说明。
export default function ChapterImages({ images = [], height = 200, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    setIndex(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [images.length, images[0] && images[0].source]);

  if (!images || images.length === 0) return null;
  const safeIndex = Math.min(Math.max(index, 0), images.length - 1);

  const onMomentumScrollEnd = event => {
    if (width <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setIndex(Math.max(0, Math.min(next, images.length - 1)));
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
            {images.map((item, itemIndex) => (
              <View key={`page-${itemIndex}`} style={[styles.page, { width }]}>
                <Image source={item.source} style={[styles.image, { height }]} resizeMode="contain" />
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>
      {images.length > 1 ? (
        <View style={styles.dots}>
          {images.map((item, itemIndex) => (
            <View
              key={`dot-${itemIndex}`}
              style={[styles.dot, itemIndex === safeIndex && styles.dotActive]}
            />
          ))}
        </View>
      ) : null}
      {images[safeIndex] && images[safeIndex].caption ? (
        <Text style={styles.caption}>{images[safeIndex].caption}</Text>
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
