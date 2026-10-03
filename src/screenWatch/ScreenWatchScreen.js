// 看手机面板（App 内截图版）：截屏 → 视觉模型多模态评论。
// v1 固有限制（如实告知用户）：截图只可能是本应用画面，且截屏时看手机面板
// 自身就在画面里；跨应用截屏（MediaProjection）按用户裁决延后到价值验证之后。
// 评论只在面板内呈现、接话才进会话引用（与听歌/看书同一裁决）。

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card, EmptyState, GhostButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useApp } from '../context/AppContext.js';

import { captureAppScreen } from './capture.js';
import { useScreenWatchComments } from './useScreenWatchComments.js';

export default function ScreenWatchScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const navigation = useNavigation();
  const { characters, activeId, ensureCharacterSession, setPendingQuote } = useApp();

  const [capturing, setCapturing] = useState(false);
  const {
    comments,
    generating,
    error,
    characterId,
    setCharacterId,
    generate,
    retry,
  } = useScreenWatchComments({ characters, defaultCharacterId: activeId });

  const selectedCharacter = useMemo(
    () => characters.find(item => item.id === characterId) || null,
    [characterId, characters]
  );

  // 截屏并立即请求评论；截图先存本地，重试复用同一张（评论针对的是同一画面）。
  const handleCapture = useCallback(async () => {
    if (capturing || generating) return;
    setCapturing(true);
    try {
      const { uri } = await captureAppScreen();
      await generate({ imageUri: uri });
    } catch (error) {
      Alert.alert('截屏失败', '没能完成截屏，请重试。');
    } finally {
      setCapturing(false);
    }
  }, [capturing, generating, generate]);

  const handleQuoteComment = useCallback(async comment => {
    if (!comment || !comment.characterId) return;
    try {
      const session = await ensureCharacterSession(comment.characterId);
      if (!session || !session.id) throw new Error('no-session');
      setPendingQuote({
        sessionId: session.id,
        payload: {
          id: '',
          name: comment.characterName || '角色',
          role: 'assistant',
          text: comment.text,
        },
      });
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('无法接话', '没能打开该角色的会话，请稍后重试。');
    }
  }, [ensureCharacterSession, navigation, setPendingQuote]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.listContent}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>一起看屏幕</Text>
      </View>

      <Card style={styles.captureCard}>
        <Text style={styles.sectionTitle}>一起看屏幕的角色</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
          {characters.map(item => {
            const selected = item.id === characterId;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.characterChip, selected && styles.characterChipActive]}
                onPress={() => setCharacterId(item.id)}
                activeOpacity={0.8}
              >
                <Text
                  style={[styles.characterChipText, selected && styles.characterChipTextActive]}
                  numberOfLines={1}
                >
                  {String(item.name || '').trim() || '角色'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <TouchableOpacity
          style={[styles.captureButton, (capturing || generating) && styles.captureButtonDisabled]}
          onPress={handleCapture}
          disabled={capturing || generating}
          activeOpacity={0.85}
        >
          {(capturing || generating)
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="eye-outline" size={18} color={theme.colors.primaryContrast} />}
          <Text style={styles.captureText}>
            {capturing ? '截屏中…' : generating ? 'TA正在看…' : '截屏给TA看看'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.hint}>
          截图只包含本应用的画面（截屏时这个面板也会入镜），需要模型支持识图。
          跨应用看屏幕需系统投屏授权，暂时没有做。
        </Text>
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <GhostButton title="重试" small onPress={retry} />
          </View>
        ) : null}
      </Card>

      {comments.length === 0 && !generating ? (
        <EmptyState
          icon="eye-outline"
          title="还没有一起看屏幕"
          description={
            selectedCharacter
              ? `点上面的按钮截个屏，${String(selectedCharacter.name || '角色').trim() || '角色'}会看看你的屏幕并聊聊。`
              : '先选一位角色，再点上面的按钮截屏。'
          }
        />
      ) : comments.map(comment => (
        <View key={comment.id} style={styles.commentCard}>
          <View style={styles.commentHead}>
            <Text style={styles.commentName} numberOfLines={1}>
              {comment.characterName || '角色'} · 看屏幕
            </Text>
            <TouchableOpacity
              style={styles.quoteButton}
              onPress={() => handleQuoteComment(comment)}
              activeOpacity={0.85}
            >
              <Text style={styles.quoteButtonText}>接话</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.commentText}>{comment.text}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  captureCard: { marginBottom: tokens.metrics.cardGap },
  sectionTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  chipScroll: { flexGrow: 0, marginBottom: 12 },
  characterChip: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  characterChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  characterChipText: { color: theme.colors.text, fontSize: fonts.scaled(12), maxWidth: 120 },
  characterChipTextActive: { color: theme.colors.primaryContrast, fontWeight: '600' },
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 12,
  },
  captureButtonDisabled: { opacity: 0.7 },
  captureText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 10, lineHeight: fonts.scaled(16) },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
  },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), flex: 1, marginRight: 8 },
  commentCard: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 10,
    marginBottom: tokens.metrics.cardGap,
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  commentName: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1, marginRight: 8 },
  quoteButton: {
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  quoteButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(11), fontWeight: '600' },
  commentText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
});
