import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { TUTORIAL_SECTIONS } from './tutorialContent';
import { useTheme } from './theme/ThemeContext';

export default function TutorialModal({ visible, onClose }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const sections = Array.isArray(TUTORIAL_SECTIONS) ? TUTORIAL_SECTIONS : [];
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>使用教程</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭教程">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {sections.map(section => (
            <View key={section.id} style={styles.card}>
              <View style={styles.cardTitleRow}>
                <Ionicons name={section.icon} size={16} color={theme.colors.primaryMuted} />
                <Text style={styles.cardTitle}>{section.title}</Text>
              </View>
              {section.intro ? <Text style={styles.intro}>{section.intro}</Text> : null}
              {(section.items || []).map(item => (
                <View key={`${section.id}-${item.name}`} style={styles.item}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemWhere}>位置：{item.where}</Text>
                  <Text style={styles.itemUsage}>用法：{item.usage}</Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
        <TouchableOpacity style={styles.button} onPress={onClose} activeOpacity={0.85}>
          <Text style={styles.buttonText}>关闭</Text>
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
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginBottom: 8 },
  item: {
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  itemName: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700' },
  itemWhere: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 3 },
  itemUsage: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 2 },
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
