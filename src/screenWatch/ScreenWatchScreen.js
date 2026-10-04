// 看手机面板（App 内截图版）：截屏 → 视觉模型多模态评论。
// v1 固有限制（如实告知用户）：截图只可能是本应用画面，且截屏时看手机面板
// 自身就在画面里；跨应用截屏（MediaProjection）按用户裁决延后到价值验证之后。
// 评论只在面板内呈现、接话才进会话引用（与听歌/看书同一裁决）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { markMediaWrite } from '../storage/mediaProtection.js';

import { useTranslation } from '../i18n/I18nContext.js';

import { captureAppScreen } from './capture.js';
import {
  addCaptureListener,
  addRequestCaptureListener,
  addStateListener,
  canDrawOverlays,
  captureOverlayFrame,
  isOverlayActive,
  isOverlaySupported,
  requestCapturePermission,
  requestOverlayPermission,
  startOverlay,
  stopOverlay,
  updateOverlayText,
} from './overlay.js';
import { resolveScreenWatchCapabilities, useScreenWatchComments } from './useScreenWatchComments.js';

// 视频观屏（模型声明视频能力时）以周期帧序列近似「连续看」。
const OVERLAY_VIDEO_FRAMES = 4;
const OVERLAY_FRAME_INTERVAL_MS = 1200;
const OVERLAY_CAPTURE_TIMEOUT_MS = 6000;

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export default function ScreenWatchScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const navigation = useNavigation();
  const { t } = useTranslation();
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

  // ---- 悬浮窗（跨应用看屏幕）----
  const overlaySupported = useMemo(() => isOverlaySupported(), []);
  const [overlayActive, setOverlayActive] = useState(false);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const overlayBusyRef = useRef(false);
  const captureWaiterRef = useRef(null);

  // 等待原生回传一帧；超时返回 null，避免永久挂起。
  const waitForCapture = useCallback(() => new Promise(resolve => {
    const timer = setTimeout(() => {
      if (captureWaiterRef.current && captureWaiterRef.current.timer === timer) {
        captureWaiterRef.current = null;
      }
      resolve(null);
    }, OVERLAY_CAPTURE_TIMEOUT_MS);
    captureWaiterRef.current = { resolve, timer };
  }), []);

  const settleCapture = useCallback(path => {
    const waiter = captureWaiterRef.current;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    captureWaiterRef.current = null;
    waiter.resolve(String(path || '') || null);
  }, []);

  useEffect(() => {
    if (!overlaySupported) return undefined;
    let cancelled = false;
    (async () => {
      const active = await isOverlayActive();
      if (!cancelled) setOverlayActive(active);
    })();
    return () => { cancelled = true; };
  }, [overlaySupported]);

  // 用户在小窗点「截屏」：识图门控 → 单帧/帧序列 → 生成评论 → 回写小窗文案。
  const handleOverlayRequestCapture = useCallback(async () => {
    if (overlayBusyRef.current || generating) return;
    overlayBusyRef.current = true;
    setOverlayBusy(true);
    try {
      const caps = await resolveScreenWatchCapabilities();
      if (!caps.vision) {
        await updateOverlayText(t('screenWatch.error.noVision'));
        return;
      }
      const frames = caps.video ? OVERLAY_VIDEO_FRAMES : 1;
      const uris = [];
      for (let index = 0; index < frames; index += 1) {
        const pending = waitForCapture();
        const accepted = await captureOverlayFrame();
        if (!accepted) break;
        const path = await pending;
        if (!path) break;
        markMediaWrite(path);
        uris.push(path);
        if (index < frames - 1) await delay(OVERLAY_FRAME_INTERVAL_MS);
      }
      if (uris.length === 0) {
        await updateOverlayText(t('screenWatch.overlay.captureFailed'));
        return;
      }
      const commentText = await generate(frames > 1 ? { imageUris: uris } : { imageUri: uris[0] });
      if (commentText) await updateOverlayText(commentText);
    } finally {
      overlayBusyRef.current = false;
      setOverlayBusy(false);
    }
  }, [generating, generate, waitForCapture, t]);

  const overlayRequestHandlerRef = useRef(handleOverlayRequestCapture);
  overlayRequestHandlerRef.current = handleOverlayRequestCapture;

  useEffect(() => {
    if (!overlaySupported) return undefined;
    const offCapture = addCaptureListener(({ path }) => settleCapture(path));
    const offRequest = addRequestCaptureListener(() => { overlayRequestHandlerRef.current(); });
    const offState = addStateListener(({ active }) => setOverlayActive(active));
    return () => { offCapture(); offRequest(); offState(); };
  }, [overlaySupported, settleCapture]);

  const handleOpenOverlay = useCallback(async () => {
    if (overlayBusyRef.current) return;
    overlayBusyRef.current = true;
    setOverlayBusy(true);
    try {
      if (!(await canDrawOverlays())) {
        await requestOverlayPermission();
        Alert.alert(t('screenWatch.overlay.permission.title'), t('screenWatch.overlay.permission.body'));
        return;
      }
      if (!(await requestCapturePermission())) {
        Alert.alert(t('screenWatch.overlay.capturePerm.title'), t('screenWatch.overlay.capturePerm.body'));
        return;
      }
      const started = await startOverlay();
      if (started) {
        setOverlayActive(true);
      } else {
        Alert.alert(t('screenWatch.overlay.startFailed'), t('screenWatch.overlay.startFailed'));
      }
    } finally {
      overlayBusyRef.current = false;
      setOverlayBusy(false);
    }
  }, [t]);

  const handleCloseOverlay = useCallback(async () => {
    if (overlayBusyRef.current) return;
    overlayBusyRef.current = true;
    setOverlayBusy(true);
    try {
      await stopOverlay();
      setOverlayActive(false);
    } finally {
      overlayBusyRef.current = false;
      setOverlayBusy(false);
    }
  }, []);

  // 截屏并立即请求评论；截图先存本地，重试复用同一张（评论针对的是同一画面）。
  const handleCapture = useCallback(async () => {
    if (capturing || generating) return;
    setCapturing(true);
    try {
      const { uri } = await captureAppScreen();
      await generate({ imageUri: uri });
    } catch (error) {
      Alert.alert(t('screenWatch.capture.failed.title'), t('screenWatch.capture.failed.body'));
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
          name: comment.characterName || t('common.characterFallback'),
          role: 'assistant',
          text: comment.text,
        },
      });
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert(t('screenWatch.quoteFailed.title'), t('screenWatch.quoteFailed.body'));
    }
  }, [ensureCharacterSession, navigation, setPendingQuote]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.listContent}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('screenWatch.title')}</Text>
      </View>

      {overlaySupported ? (
        <Card style={styles.captureCard}>
          <Text style={styles.overlayTitle}>{t('screenWatch.overlay.title')}</Text>
          <Text style={styles.hint}>{t('screenWatch.overlay.description')}</Text>
          <View style={styles.overlayStatusRow}>
            <View style={[styles.overlayDot, overlayActive && styles.overlayDotActive]} />
            <Text style={styles.overlayStatus}>
              {overlayActive ? t('screenWatch.overlay.statusOn') : t('screenWatch.overlay.statusOff')}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.captureButton, (overlayBusy || generating) && styles.captureButtonDisabled]}
            onPress={overlayActive ? handleCloseOverlay : handleOpenOverlay}
            disabled={overlayBusy || generating}
            activeOpacity={0.85}
          >
            {overlayBusy
              ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
              : (
                <Ionicons
                  name={overlayActive ? 'close-circle-outline' : 'albums-outline'}
                  size={18}
                  color={theme.colors.primaryContrast}
                />
              )}
            <Text style={styles.captureText}>
              {overlayActive ? t('screenWatch.overlay.close') : t('screenWatch.overlay.open')}
            </Text>
          </TouchableOpacity>
          <Text style={styles.hint}>{t('screenWatch.overlay.privacy')}</Text>
        </Card>
      ) : (
        <Card style={styles.captureCard}>
          <Text style={styles.overlayTitle}>{t('screenWatch.overlay.title')}</Text>
          <Text style={styles.hint}>{t('screenWatch.overlay.unsupported')}</Text>
        </Card>
      )}

      <Card style={styles.captureCard}>
        <Text style={styles.sectionTitle}>{t('screenWatch.characterLabel')}</Text>
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
                  {String(item.name || '').trim() || t('common.characterFallback')}
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
            {capturing
              ? t('screenWatch.capture.busy')
              : (generating ? t('screenWatch.capture.reading') : t('screenWatch.capture'))}
          </Text>
        </TouchableOpacity>
        <Text style={styles.hint}>{t('screenWatch.limits')}</Text>
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <GhostButton title={t('common.retry')} small onPress={retry} />
          </View>
        ) : null}
      </Card>

      {comments.length === 0 && !generating ? (
        <EmptyState
          icon="eye-outline"
          title={t('screenWatch.empty.title')}
          description={selectedCharacter
            ? t('screenWatch.empty', {
              character: String(selectedCharacter.name || '').trim() || t('common.characterFallback'),
            })
            : t('screenWatch.empty.noCharacter')}
        />
      ) : comments.map(comment => (
        <View key={comment.id} style={styles.commentCard}>
          <View style={styles.commentHead}>
            <Text style={styles.commentName} numberOfLines={1}>
              {comment.characterName || t('common.characterFallback')} · {t('screenWatch.commentLabel')}
            </Text>
            <TouchableOpacity
              style={styles.quoteButton}
              onPress={() => handleQuoteComment(comment)}
              activeOpacity={0.85}
            >
              <Text style={styles.quoteButtonText}>{t('screenWatch.quote')}</Text>
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
  overlayTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 6 },
  overlayStatusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginBottom: 10 },
  overlayDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.textFaint,
    marginRight: 6,
  },
  overlayDotActive: { backgroundColor: theme.colors.primary },
  overlayStatus: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
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
