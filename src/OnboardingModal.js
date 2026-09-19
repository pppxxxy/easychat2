import React, { useMemo, useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ONBOARDING_CHAPTERS } from './onboardingContent';
import { getOnboardingImages } from './onboarding/images';
import ChapterNotice from './ChapterNotice';
import { useTheme } from './theme/ThemeContext';

export default function OnboardingModal({ visible, onFinish }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const chapters = Array.isArray(ONBOARDING_CHAPTERS) ? ONBOARDING_CHAPTERS : [];
  const [index, setIndex] = useState(0);

  const total = chapters.length;
  const chapter = chapters[Math.min(index, Math.max(total - 1, 0))];
  const images = getOnboardingImages(chapter);
  const isFirst = index <= 0;
  const isLast = index >= total - 1;

  const goPrev = () => setIndex(current => Math.max(current - 1, 0));
  const goNext = () => {
    if (isLast) {
      onFinish?.();
    } else {
      setIndex(current => Math.min(current + 1, total - 1));
    }
  };

  if (!chapter) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onFinish}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.progressWrap}>
            <Text style={styles.progressText}>{`新手教学 ${index + 1} / ${total}`}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${((index + 1) / total) * 100}%` }]} />
            </View>
          </View>
          <TouchableOpacity onPress={onFinish} hitSlop={8} accessibilityLabel="跳过新手教学">
            <Text style={styles.skipText}>跳过</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleRow}>
            <View style={styles.iconBadge}>
              <Ionicons name={chapter.icon || 'information-circle-outline'} size={18} color={theme.colors.primaryContrast} />
            </View>
            <Text style={styles.title}>{chapter.title}</Text>
          </View>

          {chapter.summary ? <Text style={styles.summary}>{chapter.summary}</Text> : null}

          <ChapterNotice disclaimer={chapter.disclaimer} warning={chapter.warning} links={chapter.links} />

          {chapter.intro ? <Text style={styles.intro}>{chapter.intro}</Text> : null}

          {images.map((item, imageIndex) => (
            <View key={`${chapter.id}-image-${imageIndex}`} style={styles.figure}>
              <Image source={item.source} style={styles.image} resizeMode="contain" />
              {item.caption ? <Text style={styles.figureCaption}>{item.caption}</Text> : null}
            </View>
          ))}

          {(chapter.steps || []).map((step, stepIndex) => (
            <View key={`${chapter.id}-step-${stepIndex}`} style={styles.stepRow}>
              <View style={styles.stepIndex}>
                <Text style={styles.stepIndexText}>{stepIndex + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}

          {chapter.note ? (
            <View style={styles.noteBox}>
              <Ionicons name="alert-circle-outline" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.noteText}>{chapter.note}</Text>
            </View>
          ) : null}

          <View style={styles.dots}>
            {chapters.map((item, dotIndex) => (
              <View
                key={item.id}
                style={[styles.dot, dotIndex === index && styles.dotActive]}
              />
            ))}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.secondaryButton, isFirst && styles.buttonDisabled]}
            onPress={goPrev}
            disabled={isFirst}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryButtonText}>上一步</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={goNext}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryButtonText}>{isLast ? '开始使用' : '下一步'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  progressWrap: { flex: 1, marginRight: 12 },
  progressText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600', marginBottom: 6 },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.primary },
  skipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 18, paddingBottom: 28 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  iconBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    marginRight: 10,
  },
  title: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(19), fontWeight: '800' },
  summary: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700', lineHeight: fonts.scaled(20), marginBottom: 8 },
  intro: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(22), marginBottom: 14 },
  image: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
  },
  figure: { marginBottom: 14 },
  figureCaption: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 6,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  stepIndex: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 10,
    marginTop: 1,
  },
  stepIndexText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '800' },
  stepText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(21) },
  noteBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
  },
  noteText: { flex: 1, color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(19), marginLeft: 8 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 18 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surfaceBorder,
    marginHorizontal: 3,
    marginVertical: 3,
  },
  dotActive: { backgroundColor: theme.colors.primary, width: 16 },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 10,
  },
  secondaryButtonText: { color: theme.colors.textMuted, fontWeight: '700', fontSize: fonts.scaled(15) },
  buttonDisabled: { opacity: 0.4 },
  primaryButton: {
    flex: 1.4,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  primaryButtonText: { color: theme.colors.primaryContrast, fontWeight: '800', fontSize: fonts.scaled(15) },
});
