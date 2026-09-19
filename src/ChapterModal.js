import React, { useMemo } from 'react';
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

import { getOnboardingChapters } from './onboardingContent';
import { getOnboardingImages } from './onboarding/images';
import { useTheme } from './theme/ThemeContext';

export default function ChapterModal({
  visible,
  onClose,
  chapterIds,
  title = '使用教程',
  buttonText = '关闭',
}) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const chapters = getOnboardingChapters(chapterIds);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭教学">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {chapters.map(chapter => {
            const images = getOnboardingImages(chapter);
            return (
              <View key={chapter.id} style={styles.card}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name={chapter.icon || 'information-circle-outline'} size={16} color={theme.colors.primaryMuted} />
                  <Text style={styles.cardTitle}>{chapter.title}</Text>
                </View>
                {chapter.summary ? <Text style={styles.summary}>{chapter.summary}</Text> : null}
                {chapter.intro ? <Text style={styles.intro}>{chapter.intro}</Text> : null}
                {images.map((item, imageIndex) => (
                  <View key={`${chapter.id}-image-${imageIndex}`} style={styles.figure}>
                    <Image source={item.source} style={styles.image} resizeMode="contain" />
                    {item.caption ? <Text style={styles.figureCaption}>{item.caption}</Text> : null}
                  </View>
                ))}
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
              </View>
            );
          })}
        </ScrollView>
        <TouchableOpacity style={styles.button} onPress={onClose} activeOpacity={0.85}>
          <Text style={styles.buttonText}>{buttonText}</Text>
        </TouchableOpacity>
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 8 },
  summary: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700', lineHeight: fonts.scaled(19), marginBottom: 6 },
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginBottom: 8 },
  figure: { marginBottom: 10 },
  image: {
    width: '100%',
    height: 180,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
  },
  figureCaption: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 6,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  stepIndex: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '800', marginRight: 6, minWidth: 18 },
  stepText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20) },
  item: {
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  itemName: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700' },
  itemWhere: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 3 },
  itemUsage: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 2 },
  note: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(19), marginTop: 10, fontStyle: 'italic' },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 20,
    marginTop: 8,
  },
  buttonText: { color: theme.colors.primaryContrast, fontWeight: '800', fontSize: fonts.scaled(15) },
});
