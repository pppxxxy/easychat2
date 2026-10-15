// 看手机面板（App 内截图版）：截屏 → 视觉模型多模态评论。
// v1 固有限制（如实告知用户）：截图只可能是本应用画面，且截屏时看手机面板
// 自身就在画面里；跨应用截屏（MediaProjection）按用户裁决延后到价值验证之后。
// 评论只在面板内呈现、接话才进会话引用（与听歌/看书同一裁决）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card, EmptyState, GhostButton } from '../ui/index.js';
import PaneHeader from '../ui/PaneHeader.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useApp } from '../context/AppContext.js';
import { markMediaWrite } from '../storage/mediaProtection.js';
import { maskSecrets } from '../storage/secrets.js';

import { useTranslation } from '../i18n/I18nContext.js';

import AccessibilityCard from './AccessibilityCard.js';
import AvatarCard from './AvatarCard.js';
import FrameRecognitionCard from './FrameRecognitionCard.js';
import { captureAppScreen } from './capture.js';
import { reportCaptureFailure, reportOverlayCrashReports } from './screenWatchDiagnostics.js';
import { useOverlayChatSend } from './useOverlayChatSend.js';
import useOverlayActive from './useOverlayActive.js';
import {
  addCaptureFailedListener,
  addCaptureListener,
  addChatSendListener,
  addRequestCaptureListener,
  addTraceListener,
  captureOverlayFrame,
  ensurePermissionThenStart,
  isIgnoringBatteryOptimizations,
  isOverlaySupported,
  openBatteryOptimizationSettings,
  setOverlayCharacterName,
  stopOverlay,
  updateOverlayText,
} from './overlay.js';
// 纯映射从 overlayEvents.js 取：那一层零 RN 依赖、可 Node 直测（overlay.js 会碰原生模块）。
import { captureFailureKey, overlayStartFailureAlert } from './overlayEvents.js';
import { resolveScreenWatchCapabilities, useScreenWatchComments } from './useScreenWatchComments.js';
import { THREAD_IDLE_MS, getScreenWatchThreads } from './threads.js';

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
  // 和角色说话：输入草稿 + 当前「看屏幕对话」（连续截屏/说话归入同一场，见 threads.js）。
  const [draft, setDraft] = useState('');
  const [thread, setThread] = useState(null);
  const {
    comments,
    generating,
    error,
    lastErrorRef,
    characterId,
    setCharacterId,
    generate,
    retry,
    remove,
    clearAll,
  } = useScreenWatchComments({ characters, defaultCharacterId: activeId });

  const selectedCharacter = useMemo(
    () => characters.find(item => item.id === characterId) || null,
    [characterId, characters]
  );

  // ---- 悬浮窗（跨应用看屏幕）----
  const overlaySupported = useMemo(() => isOverlaySupported(), []);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const overlayBusyRef = useRef(false);
  const captureWaiterRef = useRef(null);
  // 最近一次采集失败的原因（原生回报）：用于给出可处置的提示，而不是笼统的「没能抓到画面」。
  const captureErrorRef = useRef('');

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

  // FEAT-AC5 P0-B：悬浮窗状态改为共用 hook——挂载查询 + 事件推送 + **回前台对账**。
  // 原先这里只在挂载时查一次（下面那段被本 hook 取代），用户从悬浮窗自己的「关闭」
  // 关掉后（app 在后台，原生事件被 ROM 冻结丢失），状态行会永久停在「关闭悬浮窗」，
  // 点一下反而撞上「已在运行」。工作区面板同一个病，两处共用一份实现。
  const {
    active: overlayActive,
    setActive: setOverlayActive,
  } = useOverlayActive();

  // FIX-SW5 P1-4：把上一次进程死亡的第一现场送进诊断日志。
  // 读取 / 上报 / 删除都在 screenWatchDiagnostics（读完即删 → 只报一次）。
  // 挂在这里而不是 App 启动：诊断是这一页的能力，不该让全局启动路径依赖它。
  useEffect(() => {
    let cancelled = false;
    reportOverlayCrashReports().then(count => {
      if (cancelled || !count) return;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 小窗回写文案：优先真实原因（悬浮窗在面板外，看不到面板里的错误横幅），
  // 过长则截断——小窗状态区只有一两行的显示空间。
  const overlayErrorText = useCallback(caught => {
    const raw = caught
      ? maskSecrets(String((caught && caught.message) || '')).trim()
      : String(lastErrorRef.current || '').trim();
    const text = raw || t('screenWatch.comments.failed');
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }, [lastErrorRef, t]);

  // 后台冻结引导（FIX-4 第 4 条）：超时且系统尚未放行后台运行时，提示一次。
  // 「只提示一次」存在 ref 里而非持久化：重启后如果又超时，再提醒一次是合理的
  //（用户可能只是忘了改）；同一次运行内不反复打扰。
  const batteryGuidanceShownRef = useRef(false);
  const maybeOfferBatteryGuidance = useCallback(async () => {
    if (batteryGuidanceShownRef.current) return;
    if (await isIgnoringBatteryOptimizations()) return;
    batteryGuidanceShownRef.current = true;
    Alert.alert(
      t('screenWatch.battery.title'),
      t('screenWatch.battery.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('screenWatch.battery.open'),
          onPress: () => { openBatteryOptimizationSettings().catch(() => {}); },
        },
      ]
    );
  }, [t]);

  // 用户在小窗点「截屏」：识图门控 → 单帧/帧序列 → 生成评论 → 回写小窗文案。
  const handleOverlayRequestCapture = useCallback(async () => {
    if (overlayBusyRef.current || generating) return;
    overlayBusyRef.current = true;
    setOverlayBusy(true);
    try {
      const caps = await resolveScreenWatchCapabilities(characterId);
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
        const reason = captureErrorRef.current;
        captureErrorRef.current = '';
        // FIX-4：按**原因码**给不同文案。此前只把 no-projection/projection-denied 归为一类，
        // 其余（含 timeout / no-frame / projection-invalid）一律「没能抓到画面，请重试」——
        // 对「授权已失效」或「系统冻结了后台」这两种需要用户动手的情况毫无帮助，用户只会反复重试。
        await updateOverlayText(t(captureFailureKey(reason)));
        // 超时是 ROM 后台冻结的典型征兆（线程化之后仍然超时，基本只剩这一个解释）：
        // 此时给一次性引导，指路去关掉电池优化。不是每次超时都弹——用户点了「知道了」就不再烦他。
        if (reason === 'timeout') await maybeOfferBatteryGuidance();
        return;
      }
      const commentText = await generate(frames > 1 ? { imageUris: uris } : { imageUri: uris[0] });
      // 生成失败也要回写小窗：否则小窗会永远停在「正在看…」，用户以为卡死。
      // 失败时优先回写真实原因（lastErrorRef），小窗在面板外看不到面板里的错误横幅。
      await updateOverlayText(commentText || overlayErrorText());
    } catch (error) {
      // 任何未预期异常也不能让小窗卡在「正在看…」。
      await updateOverlayText(overlayErrorText(error)).catch(() => {});
    } finally {
      overlayBusyRef.current = false;
      setOverlayBusy(false);
    }
  }, [generating, generate, overlayErrorText, waitForCapture, maybeOfferBatteryGuidance, t]);

  const overlayRequestHandlerRef = useRef(handleOverlayRequestCapture);
  overlayRequestHandlerRef.current = handleOverlayRequestCapture;

  // SW3 / FEAT-AC4 P0-A：悬浮窗聊天回合（按 scope 分流）已外提为 hook——
  // ScreenWatchScreen 贴着 800 行棘轮，而那块是自足的（见该文件注释）。
  const handleOverlayChatSend = useOverlayChatSend({
    generate,
    errorText: overlayErrorText,
    t,
  });
  const overlayChatHandlerRef = useRef(handleOverlayChatSend);
  overlayChatHandlerRef.current = handleOverlayChatSend;

  useEffect(() => {
    if (!overlaySupported) return undefined;
    const offCapture = addCaptureListener(({ path }) => settleCapture(path));
    // 原生明确回报失败：立即结束等待（不必等 6s 超时），并记下原因供提示分流。
    const offFailed = addCaptureFailedListener(({ reason }) => {
      captureErrorRef.current = reason;
      settleCapture('');
    });
    const offRequest = addRequestCaptureListener(() => { overlayRequestHandlerRef.current(); });
    // 状态订阅（含回前台对账）已在 useOverlayActive 里挂好——这里不再重复订阅
    // addStateListener：两个监听器写同一份状态只会让「谁才是权威」变模糊。
    // FIX-4：采集链路打点 → 诊断日志（addTraceListener 内部已写，这里无需额外处理；
    // 订阅本身保证即使无人关心也会落盘，便于「一直等」类故障事后定位卡在哪一环）。
    const offTrace = addTraceListener();
    // SW3：悬浮窗里发来的话——按 scope 走对应管线（聊天角色 / 工作区 agent），
    // 结果经 pushOverlayChatMessage 推回悬浮窗渲染（原生只做嘴和眼）。
    const offChat = addChatSendListener(payload => { overlayChatHandlerRef.current(payload); });
    return () => { offCapture(); offFailed(); offRequest(); offTrace(); offChat(); };
  }, [overlaySupported, settleCapture]);

  // 小窗标题跟随当前角色（用户要求顶部显示角色名，而不是固定的「看屏幕」）。
  const overlayCharacterName = useMemo(
    () => (selectedCharacter ? String(selectedCharacter.name || '').trim() : ''),
    [selectedCharacter]
  );
  useEffect(() => {
    if (!overlaySupported || !overlayActive) return;
    setOverlayCharacterName(overlayCharacterName);
  }, [overlaySupported, overlayActive, overlayCharacterName]);

  // ---- 悬浮窗统一启动链（FIX-3）----
  //
  // 背景：两个入口的授权逻辑**不一致**。扩展页一直走「悬浮窗→投屏授权→启动」，而设置页直接调
  // startOverlay → 必然失败。现在统一到 ensurePermissionThenStart，不再各自为政。
  const handleOpenOverlay = useCallback(async () => {
    if (overlayBusyRef.current) return;
    overlayBusyRef.current = true;
    setOverlayBusy(true);
    try {
      const result = await ensurePermissionThenStart();
      if (!result.ok) {
        // 失败档位 → 文案（映射抽到 overlayEvents，两入口共用同一份，见那里的说明）。
        const alertCopy = overlayStartFailureAlert(result.reason);
        Alert.alert(
          alertCopy.titleKey ? t(alertCopy.titleKey) : t('screenWatch.overlay.startFailed'),
          t(alertCopy.bodyKey)
        );
        return;
      }
      setOverlayActive(true);
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
  //
  // FIX-SW5 P1-5：**两段必须分开 try**——原实现包在一个 try 里，生成失败也报
  // 「没能完成截屏」，把排查方向带偏（与 CI 那次 workflow/job 同名是同一类错误）。
  // 上报细节（脱敏、兼容字符串抛出、诊断日志）见 screenWatchDiagnostics。
  const handleCapture = useCallback(async () => {
    if (capturing || generating) return;
    setCapturing(true);
    try {
      let uri;
      try {
        ({ uri } = await captureAppScreen());
      } catch (error) {
        reportCaptureFailure({
          stage: 'capture', kind: 'storage', error, context: 'view-shot',
          title: t('screenWatch.capture.failed.title'),
          body: t('screenWatch.capture.failed.body'),
        });
        return;
      }
      try {
        await generate({ imageUri: uri });
      } catch (error) {
        reportCaptureFailure({
          stage: 'generate', kind: 'api', error, context: 'generate',
          title: t('screenWatch.generate.failed.title'),
          body: t('screenWatch.generate.failed.body'),
        });
      }
    } finally {
      // 唯一的复位点：两段谁失败都不会漏掉（把它放进内层 catch 很容易漏一处）。
      setCapturing(false);
    }
  }, [capturing, generating, generate, t, reportCaptureFailure]);

  // 当前对话（只读展示）：不在展示路径上创建对话，创建只发生在真正生成时。
  const reloadThread = useCallback(async () => {
    if (!characterId) {
      setThread(null);
      return;
    }
    try {
      const list = await getScreenWatchThreads();
      const now = Date.now();
      setThread(list.find(item => (
        item.characterId === characterId && now - item.updatedAt <= THREAD_IDLE_MS
      )) || null);
    } catch (error) {
      setThread(null);
    }
  }, [characterId]);

  useEffect(() => {
    reloadThread();
  }, [reloadThread]);

  // 有新评论（含悬浮窗路径）就刷新对话展示。
  useEffect(() => {
    if (comments.length > 0) reloadThread();
  }, [comments.length, reloadThread]);

  // 用户主动说话：不带截图时为纯文字对话，同样落进当前「看屏幕对话」。
  const handleSendText = useCallback(async () => {
    const text = String(draft || '').trim();
    if (!text || generating) return;
    setDraft('');
    await generate({ userText: text });
  }, [draft, generate, generating]);

  // 删除单条评论卡片（带二次确认，范式照抄记忆页删线程）：只删 comments 存储，
  // 对话线程（含截图与对话文本、作为 AI 上下文）不动——那是记忆页的管辖。
  const handleDeleteComment = useCallback(comment => {
    if (!comment || !comment.id) return;
    Alert.alert(
      t('screenWatch.comments.delete.title'),
      t('screenWatch.comments.delete.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => remove(comment.id),
        },
      ]
    );
  }, [remove, t]);

  const handleClearComments = useCallback(() => {
    if (comments.length === 0) return;
    Alert.alert(
      t('screenWatch.comments.clear.title'),
      t('screenWatch.comments.clear.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => clearAll(),
        },
      ]
    );
  }, [clearAll, comments.length, t]);

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
      navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert(t('screenWatch.quoteFailed.title'), t('screenWatch.quoteFailed.body'));
    }
  }, [ensureCharacterSession, navigation, setPendingQuote]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.listContent}>
      <PaneHeader title={t('screenWatch.title')} onBack={() => navigation.goBack()} />

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

      {/* accessibility status card + frame recognition source picker + ball avatar */}
      <AccessibilityCard />
      <FrameRecognitionCard />
      <AvatarCard />

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

      <Card style={styles.captureCard}>
        <Text style={styles.overlayTitle}>{t('screenWatch.talk.title')}</Text>
        <Text style={styles.hint}>
          {thread && thread.entries.length > 0
            ? t('screenWatch.talk.hintActive', { count: thread.entries.length })
            : t('screenWatch.talk.hint')}
        </Text>
        {thread && thread.entries.length > 0 ? (
          <View style={styles.threadList}>
            {thread.entries.slice(-6).map(entry => (
              <View key={entry.id} style={styles.threadRow}>
                <Text style={styles.threadWho} numberOfLines={1}>
                  {entry.role === 'user'
                    ? t('screenWatch.talk.you')
                    : (String(selectedCharacter?.name || '').trim() || t('common.characterFallback'))}
                </Text>
                <Text style={styles.threadText}>{entry.text}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.talkRow}>
          <TextInput
            style={styles.talkInput}
            value={draft}
            onChangeText={setDraft}
            placeholder={t('screenWatch.talk.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            returnKeyType="send"
            onSubmitEditing={handleSendText}
            editable={!generating}
          />
          <TouchableOpacity
            style={[styles.talkSend, (!draft.trim() || generating) && styles.talkSendDisabled]}
            onPress={handleSendText}
            disabled={!draft.trim() || generating}
            activeOpacity={0.85}
            accessibilityLabel={t('screenWatch.talk.send')}
          >
            {generating
              ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
              : <Ionicons name="send" size={15} color={theme.colors.primaryContrast} />}
          </TouchableOpacity>
        </View>
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
      ) : (
        <>
          {(commentsExpanded ? comments : comments.slice(0, 3)).map(comment => (
            <View key={comment.id} style={styles.commentCard}>
              <View style={styles.commentHead}>
                <Text style={styles.commentName} numberOfLines={1}>
                  {comment.characterName || t('common.characterFallback')} · {t('screenWatch.commentLabel')}
                </Text>
                <View style={styles.commentActions}>
                  <TouchableOpacity
                    style={styles.commentDeleteButton}
                    onPress={() => handleDeleteComment(comment)}
                    accessibilityLabel={t('screenWatch.comments.delete.a11y')}
                  >
                    <Ionicons name="trash-outline" size={14} color={theme.colors.textFaint} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.quoteButton}
                    onPress={() => handleQuoteComment(comment)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.quoteButtonText}>{t('screenWatch.quote')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={styles.commentText}>{comment.text}</Text>
            </View>
          ))}
          {comments.length > 3 && !commentsExpanded ? (
            <TouchableOpacity
              style={styles.commentToggle}
              onPress={() => setCommentsExpanded(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.commentToggleText}>{t('screenWatch.comments.expand', { count: comments.length })}</Text>
              <Ionicons name="chevron-down" size={14} color={theme.colors.textFaint} />
            </TouchableOpacity>
          ) : null}
          {comments.length > 0 ? (
            <TouchableOpacity
              style={styles.commentsClear}
              onPress={handleClearComments}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={13} color={theme.colors.textFaint} />
              <Text style={styles.commentsClearText}>{t('screenWatch.comments.clear')}</Text>
            </TouchableOpacity>
          ) : null}
          {comments.length > 0 ? (
            <Text style={styles.commentsHint}>{t('screenWatch.comments.threadsHint')}</Text>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
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
  threadList: { marginTop: 4, marginBottom: 10 },
  threadRow: { marginBottom: 8 },
  threadWho: { color: theme.colors.primary, fontSize: fonts.scaled(11), fontWeight: '700' },
  threadText: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    marginTop: 2,
  },
  talkRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  talkInput: {
    flex: 1,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginRight: 8,
  },
  talkSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  talkSendDisabled: { opacity: tokens.opacity.disabled },
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
  commentToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  commentToggleText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginRight: 4 },
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
  // 评论卡片头右侧的操作组：删除（垃圾桶）+ 接话，删除尺寸/配色对照 quoteButton。
  commentActions: { flexDirection: 'row', alignItems: 'center' },
  commentDeleteButton: { paddingHorizontal: 8, paddingVertical: 3, marginRight: 4 },
  // 清空全部 + 两套存储的说明：评论只在这里展示，对话线程归记忆页管。
  commentsClear: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginTop: 2,
  },
  commentsClearText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 5 },
  commentsHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 6,
  },
  commentText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
});
