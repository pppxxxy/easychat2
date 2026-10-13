// 采样分布柱状图：把上面四个参数（尤其 temperature / topK / topP）的**实际效果**
// 画出来——8 根柱子代表 8 个候选词，柱子高度 = 该词被选中的概率。
//
// 为什么值得占一块屏幕：这四个参数此前是「四个数字」，用户只能靠猜。真实管线是
// temperature → top-k → top-p 三级筛（口径见 samplingDistribution.js），一张图能把
// 「温度调低会多尖锐」「top-k=3 砍掉哪 5 根」「top-p=0.75 刚好圈进前两根」讲清楚。
//
// 实现：RN 内置 Animated（仓库没有 SVG/图表库，见 package.json）——
// 高度动画必须 useNativeDriver:false（height 不是 transform/opacity），
// 但 8 根柱子的量级下 JS driver 完全够用，且能顺带做「每根独立缓动」。

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { CANDIDATE_BASE_PROBABILITIES, buildCandidateBars } from './samplingDistribution.js';

// 柱状区高度与动画时长：太短看不出变化，太长会拖慢调参手感。
const CHART_HEIGHT = 120;
const ANIMATION_MS = 260;
// 被 top-k 裁掉的柱子：留一点透明度让用户看见「它被砍了」，而不是凭空消失
//（凭空消失会让人怀疑图算错了）。
const CUT_OPACITY = 0.18;
// 通过 top-k 但不在 top-p 内的长尾：变暗但仍可读。
const TAIL_OPACITY = 0.42;
const FULL_OPACITY = 1;

// 柱子透明度：不在 top-k 内最淡；在 top-k 内但不在 top-p 内次之；选中为全亮。
function barOpacity(bar) {
  if (!bar.kept) return CUT_OPACITY;
  return bar.selected ? FULL_OPACITY : TAIL_OPACITY;
}

// 概率 → 百分比文本。小于 0.1% 显示「<0.1%」而不是「0.0%」（后者会被误读成「不可能」）。
function formatPercent(probability) {
  const percent = (Number(probability) || 0) * 100;
  if (percent <= 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

// 一句话说明当前分布的形状——图看趋势，这行给结论。
function describeDistribution(model, temperature, topK, topP, t) {
  if (!t) return '';
  const temp = Number(temperature);
  const parts = [];
  if (Number.isFinite(temp) && temp < 1) parts.push(t('settings.sampling.chart.sharp'));
  else if (Number.isFinite(temp) && temp > 1) parts.push(t('settings.sampling.chart.flat'));
  else parts.push(t('settings.sampling.chart.neutral'));
  if (Math.floor(Number(topK)) > 0) {
    parts.push(t('settings.sampling.chart.keptK', { count: model.keptCount }));
  }
  if (Number(topP) < 1) {
    parts.push(t('settings.sampling.chart.selectedP', { count: model.selectedCount }));
  }
  return parts.join(' · ');
}

export default function SamplingChart({ temperature = 1, topK = 0, topP = 1, t }) {
  const { theme, fonts, tokens } = useTheme();

  // 每次参数变化重算分布（纯函数，见 samplingDistribution.js）。
  const model = useMemo(
    () => buildCandidateBars({ base: CANDIDATE_BASE_PROBABILITIES, temperature, topK, topP }),
    [temperature, topK, topP]
  );

  // 每根柱子一个动画值：高度比例 + 透明度。首帧直接用目标值（挂载不闪跳）。
  const heightAnims = useRef(model.bars.map(bar => new Animated.Value(bar.ratio))).current;
  const opacityAnims = useRef(model.bars.map(bar => new Animated.Value(barOpacity(bar)))).current;

  useEffect(() => {
    const animations = [];
    model.bars.forEach((bar, index) => {
      const heightAnim = heightAnims[index];
      const opacityAnim = opacityAnims[index];
      if (!heightAnim || !opacityAnim) return;
      animations.push(
        Animated.parallel([
          Animated.timing(heightAnim, {
            toValue: bar.ratio,
            duration: ANIMATION_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: false,
          }),
          Animated.timing(opacityAnim, {
            toValue: barOpacity(bar),
            duration: ANIMATION_MS,
            easing: Easing.out(Easing.quad),
            useNativeDriver: false,
          }),
        ])
      );
    });
    // 并行播放：8 根同时长，整体像一次「重新分布」而不是逐根排队。
    Animated.parallel(animations).start();
  }, [model, heightAnims, opacityAnims]);

  const styles = useMemo(
    () => createStyles(theme, fonts, tokens),
    [theme, fonts, tokens]
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.chart}>
        {model.bars.map((bar, index) => {
          const height = heightAnims[index].interpolate({
            inputRange: [0, 1],
            outputRange: [2, CHART_HEIGHT], // 最小 2px：0 高度会让柱子「消失」看不出位置
          });
          return (
            <View key={bar.index} style={styles.barSlot}>
              <Animated.View
                style={[
                  styles.bar,
                  {
                    height,
                    opacity: opacityAnims[index],
                    // 落在 top-p 内 = 高亮（主色）；否则用弱化色。
                    backgroundColor: bar.selected ? theme.colors.primary : theme.colors.primaryMuted,
                  },
                ]}
              />
              <Text style={[styles.barLabel, bar.selected && styles.barLabelActive]} numberOfLines={1}>
                {formatPercent(bar.probability)}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.caption}>{describeDistribution(model, temperature, topK, topP, t)}</Text>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: { marginTop: 10, marginBottom: 4 },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: CHART_HEIGHT + 20,
    paddingHorizontal: 2,
  },
  barSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: {
    width: '62%',
    borderTopLeftRadius: tokens.radius.sm,
    borderTopRightRadius: tokens.radius.sm,
  },
  barLabel: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(9),
    marginTop: 4,
  },
  barLabelActive: { color: theme.colors.accentText, fontWeight: '700' },
  caption: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    marginTop: 6,
    lineHeight: fonts.scaled(16),
  },
});
