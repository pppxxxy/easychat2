import React, { useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { guessCharacterIdForMessages } from './context/sessionLibrary';
import { Card, EmptyState, PrimaryButton } from './ui';
import { useTheme } from './theme/ThemeContext';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SessionRecoveryModal({
  visible,
  orphans = [],
  characters = [],
  userName = '',
  onClose,
  onRecover,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(orphans) ? orphans : [];
  const speakerCountOf = item => (item && Array.isArray(item.speakers) ? item.speakers.length : 0);
  const pickedSpeakerCount = picked ? speakerCountOf(picked) : 0;
  const pickedIsGroup = pickedSpeakerCount >= 2;

  // 用开场白猜一下归属角色，猜中的排在最前并标「推荐」
  const guessedId = useMemo(() => {
    if (!picked) return '';
    return guessCharacterIdForMessages(
      [{ role: 'assistant', text: picked.greeting }],
      characters,
      { userName }
    );
  }, [characters, picked, userName]);

  const orderedCharacters = useMemo(() => {
    const pool = Array.isArray(characters) ? characters : [];
    return [...pool].sort((a, b) => {
      if (a.id === guessedId) return -1;
      if (b.id === guessedId) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [characters, guessedId]);

  const closeAll = () => {
    setPicked(null);
    onClose();
  };

  const handlePick = async characterId => {
    if (busy || !picked) return;
    setBusy(true);
    try {
      await onRecover(picked, characterId);
      setPicked(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={closeAll}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>恢复丢失的对话</Text>
          <TouchableOpacity onPress={closeAll} hitSlop={8} accessibilityLabel="关闭">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {picked ? (
            <>
              <TouchableOpacity
                style={styles.backRow}
                onPress={() => setPicked(null)}
                activeOpacity={0.8}
                accessibilityLabel="返回列表"
              >
                <Ionicons name="chevron-back" size={16} color={theme.colors.primaryMuted} />
                <Text style={styles.backText}>返回列表</Text>
              </TouchableOpacity>
              <Text style={styles.subtitle}>
                {pickedIsGroup
                  ? `检测到这段对话有 ${pickedSpeakerCount} 位发言人，将按群聊恢复并保留成员。选一个角色只是用于排序，不影响群聊成员。`
                  : '这段对话原本属于哪个角色？选定后，它和它的记忆摘要都会回到列表里。'}
              </Text>
              <Card>
                <Text style={styles.previewLabel}>待恢复的对话</Text>
                <Text style={styles.preview} numberOfLines={3}>
                  {String(picked.preview || '').trim() || '（无预览）'}
                </Text>
                <Text style={styles.meta}>
                  {`${picked.messageCount} 条消息 · ${formatTime(picked.updatedAt) || '时间未知'}${pickedIsGroup ? ` · 疑似群聊（${pickedSpeakerCount} 位）` : ''}`}
                </Text>
              </Card>
              {orderedCharacters.length === 0 ? (
                <EmptyState
                  icon="person-outline"
                  title="没有可选角色"
                  description="请先在角色页创建或导入角色。"
                />
              ) : null}
              {orderedCharacters.map(item => (
                <TouchableOpacity
                  key={`recover-${item.id}`}
                  style={styles.row}
                  onPress={() => handlePick(item.id)}
                  disabled={busy}
                  activeOpacity={0.8}
                  accessibilityLabel={`恢复到 ${item.name || '未命名角色'}`}
                >
                  <View style={styles.rowMain}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.name || '未命名角色'}
                    </Text>
                    {item.id === guessedId ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>推荐</Text>
                      </View>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                </TouchableOpacity>
              ))}
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>
                {list.length > 0
                  ? '这些对话的消息都还在，只是会话记录丢了（旧版本新建对话时误删）。点进任意一段，选它原本属于哪个角色即可找回。'
                  : '没有发现丢失的对话。'}
              </Text>
              {list.map(item => (
                <Card key={`orphan-${item.sessionId}`}>
                  <TouchableOpacity
                    onPress={() => setPicked(item)}
                    activeOpacity={0.8}
                    accessibilityLabel="选择这段对话"
                  >
                    <View style={styles.rowMain}>
                      <Text style={styles.preview} numberOfLines={2}>
                        {String(item.preview || '').trim() || '（无预览）'}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                    </View>
                    <Text style={styles.meta}>
                      {`${item.messageCount} 条消息 · ${formatTime(item.updatedAt) || '时间未知'}${speakerCountOf(item) >= 2 ? ' · 疑似群聊' : ''}`}
                    </Text>
                  </TouchableOpacity>
                </Card>
              ))}
            </>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton title="关闭" onPress={closeAll} />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
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
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  subtitle: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    marginBottom: 12,
  },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  backText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: tokens.metrics.cardPadding,
    paddingVertical: tokens.metrics.cardPadding - 2,
    marginBottom: tokens.metrics.cardGap,
  },
  rowMain: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  rowName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', flexShrink: 1 },
  badge: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  badgeText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700' },
  previewLabel: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginBottom: 4 },
  preview: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(21), flexShrink: 1 },
  meta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6 },
  footer: {
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.background,
  },
});
