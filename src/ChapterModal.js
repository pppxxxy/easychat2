import React, { useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getOnboardingChapters } from './onboardingContent';
import { getOnboardingImages } from './onboarding/images';
import ChapterImages from './ChapterImages';
import ChapterNotice from './ChapterNotice';
import ChapterOutro from './ChapterOutro';
import ChapterSections from './ChapterSections';
import { Card, PrimaryButton } from './ui';
import { useTheme } from './theme/ThemeContext';

export default function ChapterModal({
  visible,
  onClose,
  chapterIds,
  title = '使用教程',
  buttonText = '关闭',
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const chapters = getOnboardingChapters(chapterIds);
  const scrollRef = useRef(null);
  const offsetsRef = useRef({});

  const jumpTo = id => {
    const offset = offsetsRef.current[id];
    if (typeof offset === 'number' && scrollRef.current) {
      scrollRef.current.scrollTo({ y: offset, animated: true });
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭教学">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        {chapters.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.jumpBar}
            contentContainerStyle={styles.jumpContent}
          >
            {chapters.map((chapter, chapterIndex) => (
              <TouchableOpacity
                key={`jump-${chapter.id}`}
                style={styles.jumpChip}
                onPress={() => jumpTo(chapter.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.jumpText} numberOfLines={1}>
                  {`${chapterIndex + 1}. ${chapter.title}`}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {chapters.map(chapter => {
            const images = getOnboardingImages(chapter);
            return (
              <Card
                key={chapter.id}
                onLayout={event => {
                  offsetsRef.current[chapter.id] = event.nativeEvent.layout.y;
                }}
              >
                <View style={styles.cardTitleRow}>
                  <Ionicons name={chapter.icon || 'information-circle-outline'} size={16} color={theme.colors.primaryMuted} />
                  <Text style={styles.cardTitle}>{chapter.title}</Text>
                </View>
                {chapter.summary ? <Text style={styles.summary}>{chapter.summary}</Text> : null}
                <ChapterNotice disclaimer={chapter.disclaimer} warning={chapter.warning} links={chapter.links} />
                {chapter.intro ? <Text style={styles.intro}>{chapter.intro}</Text> : null}
                <ChapterSections sections={chapter.sections} />
                <ChapterImages images={images} height={180} />
                {(chapter.steps || []).map((step, stepIndex) => (
                  <View key={`${chapter.id}-step-${stepIndex}`} style={styles.stepRow}>
                    <Text style={styles.stepIndex}>{stepIndex + 1}.</Text>
                    <Text style={styles.stepText}>{step}</Text>
                  </View>
                ))}
                {(chapter.items || []).map(item => (
                  <View key={`${chapter.id}-${item.name}`} style={styles.item}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemWhere}>位置：{item.where}</Text>
                    <Text style={styles.itemUsage}>用法：{item.usage}</Text>
                  </View>
                ))}
                {chapter.note ? <Text style={styles.note}>{chapter.note}</Text> : null}
                <ChapterOutro outro={chapter.outro} />
              </Card>
            );
          })}
        </ScrollView>
        <View style={styles.footer}>
          <PrimaryButton title={buttonText} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  jumpBar: {
    flexGrow: 0,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  jumpContent: { paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.sm },
  jumpChip: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.pill,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs + 2,
    marginRight: tokens.spacing.sm,
    maxWidth: 200,
  },
  jumpText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 8 },
  summary: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700', lineHeight: fonts.scaled(19), marginBottom: 6 },
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginBottom: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  stepIndex: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '800', marginRight: 6, minWidth: 18 },
  stepText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20) },
  item: {
    paddingVertical: 8,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  itemName: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700' },
  itemWhere: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 3 },
  itemUsage: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 2 },
  note: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(19), marginTop: 10, fontStyle: 'italic' },
  footer: {
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.background,
  },
});
