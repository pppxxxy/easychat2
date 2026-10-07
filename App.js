import './src/polyfills';
import 'react-native-gesture-handler';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Animated } from 'react-native';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatScreen from './src/ChatScreen.js';
import CharacterStack from './src/character/CharacterStack.js';
import MemoryScreen from './src/MemoryScreen.js';
import ExtensionScreen from './src/ExtensionScreen.js';
import SettingsScreen from './src/SettingsScreen.js';
import DisclaimerModal from './src/onboarding/disclaimer.js';
import OnboardingModal from './src/OnboardingModal.js';
import {
  acknowledgeDisclaimer,
  completeOnboarding,
  isDisclaimerAcknowledged,
  isOnboardingDone,
} from './src/storage/settings.js';
import { getActiveLocalModel } from './src/storage/localModels.js';
import { getDiarySettings } from './src/storage/diary.js';
import { migrateLegacyMessages } from './src/storage/sessions.js';
import { DEFAULT_CHARACTER, markDefaultGreetingShown } from './src/storage/characters.js';
import { getUserProfile } from './src/storage/personas.js';
import { AppProvider, useApp } from './src/context/AppContext.js';
import { runDiaryForNewDay } from './src/diary/runDiary.js';
import { runDiaryIfNewDay } from './src/diary/diaryStartup.js';
import {
  ackPendingMessages,
  addOpenRoleListener,
  consumeInitialRole,
  consumePendingMessages,
  isProactiveMessageAvailable,
} from './src/proactive/proactiveMessage.js';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext.js';
import { I18nProvider, useTranslation } from './src/i18n/I18nContext.js';
import { tActive } from './src/i18n/index.js';
import { ROUTE_NAMES } from './src/navigation/routeNames.js';
import { maskSecrets } from './src/storage/secrets.js';
import { getCharacterEditGuard, resolveTabName, shouldConfirmTabLeave } from './src/character/characterEditGuard.js';
import { recordDiagnostic } from './src/storage/diagnostics.js';
import { runLocalModel } from './src/localModel/adapter.js';
import { hydrateDownloadQueue } from './src/localModel/downloadQueue.js';
import {
  attachLocalApiServerInference,
  isLocalApiServerAvailable,
  stopLocalApiServer,
} from './src/localModel/localApiServer.js';
import { tryAcquireResource } from './src/resourceMutex.js';
import { useTabIconScale } from './src/ui/animations.js';

const Tab = createBottomTabNavigator();

// 通知点击可能在导航容器挂载完成前到达；用容器 ref + isReady 守卫，
// 未就绪时先把角色入队，onReady 后再消费，避免 navigate 抛
// "navigation object hasn't been initialized yet"。
const navigationRef = createNavigationContainerRef();

// 未捕获的 JS 异常：记录到本地诊断日志（脱敏）后交给原处理器，
// 保留 RN 自身的红屏/崩溃行为，只增加可追溯性。
if (global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
  const previousHandler = global.ErrorUtils.getGlobalHandler
    ? global.ErrorUtils.getGlobalHandler()
    : null;
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      recordDiagnostic('unhandled', error, isFatal ? 'fatal' : 'non-fatal');
    } catch (recordError) {}
    if (typeof previousHandler === 'function') previousHandler(error, isFatal);
  });
}

class StartupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    recordDiagnostic('startup', error, maskSecrets(String(info && info.componentStack || '')));
    console.log(
      'StartupErrorBoundary',
      maskSecrets(error && error.message),
      maskSecrets(info && info.componentStack)
    );
  }

  render() {
    if (this.state.error) {
      const crashText = `${maskSecrets(String(this.state.error && this.state.error.message))}\n\n`
        + maskSecrets(String(this.state.error && this.state.error.stack));
      return (
        <View style={styles.crashScreen}>
          <Text style={styles.crashTitle}>{tActive('app.crash.title')}</Text>
          <Text style={styles.crashHint}>{tActive('app.crash.hint')}</Text>
          <ScrollView style={styles.crashScroll}>
            <Text style={styles.crashText} selectable>
              {crashText}
            </Text>
          </ScrollView>
          {/* 复制按钮：测试者反馈崩溃时不必截图，直接复制脱敏后的文本。 */}
          <Pressable
            style={styles.crashCopyButton}
            onPress={async () => {
              try {
                await Clipboard.setStringAsync(crashText);
                Alert.alert(tActive('app.crash.copied.title'), tActive('app.crash.copied.body'));
              } catch (error) {}
            }}
          >
            <Text style={styles.crashCopyText}>{tActive('app.crash.copy')}</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const TAB_ICONS = {
  聊天: ['chatbubble-outline', 'chatbubble'],
  记忆: ['albums-outline', 'albums'],
  角色: ['people-outline', 'people'],
  扩展: ['extension-puzzle-outline', 'extension-puzzle'],
  设置: ['settings-outline', 'settings'],
};

function Header() {
  const insets = useSafeAreaInsets();
  const { theme, fonts, tokens } = useTheme();
  return (
    <View style={[styles.header, {
      paddingTop: insets.top + 12,
      backgroundColor: theme.colors.background,
      borderBottomColor: theme.colors.divider,
    }]}>
      <View style={styles.brandRow}>
        <View style={[styles.logoBadge, { backgroundColor: theme.colors.primary }, tokens.elevation(2, theme)]}>
          <Ionicons name="chatbubbles" size={20} color={theme.colors.primaryContrast} />
        </View>
        <View style={styles.brandText}>
          <Text style={[styles.title, { color: theme.colors.text, fontSize: fonts.scaled(22) }]}>EasyChat2</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textFaint, fontSize: fonts.scaled(11) }]}>AI CHAT APP</Text>
        </View>
      </View>
    </View>
  );
}

function StartupFlow({ onReady }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState('loading');

  useEffect(() => {
    if (stage === 'done' && typeof onReady === 'function') onReady();
  }, [onReady, stage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ack = await isDisclaimerAcknowledged();
        if (cancelled) return;
        if (!ack) {
          setStage('disclaimer');
          return;
        }
        const done = await isOnboardingDone();
        if (cancelled) return;
        setStage(done ? 'done' : 'onboarding');
      } catch (error) {
        if (!cancelled) setStage('disclaimer');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onDisclaimerClose = useCallback(async () => {
    try {
      await acknowledgeDisclaimer();
      const done = await isOnboardingDone();
      setStage(done ? 'done' : 'onboarding');
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    }
  }, []);

  const onOnboardingFinish = useCallback(async () => {
    try {
      await completeOnboarding();
      setStage('done');
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    }
  }, []);

  return (
    <>
      <DisclaimerModal visible={stage === 'disclaimer'} onClose={onDisclaimerClose} />
      <OnboardingModal visible={stage === 'onboarding'} onFinish={onOnboardingFinish} />
    </>
  );
}

function StartupSession() {
  const { t } = useTranslation();
  const { characters, loaded, refreshSessions, ensureCharacterSession } = useApp();
  const [retry, setRetry] = useState(0);
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);
  const retryTimerRef = useRef(null);
  const retryAttemptsRef = useRef(0);

  useEffect(() => {
    if (!loaded || startedRef.current || inFlightRef.current) return undefined;
    let cancelled = false;
    inFlightRef.current = true;
    (async () => {
      let failed = false;
      try {
        await migrateLegacyMessages(charactersRef.current);
      } catch (error) {
        failed = true;
      }
      let sessionList = null;
      try {
        sessionList = await refreshSessions();
      } catch (error) {
        failed = true;
      }
      // 首次安装（迁移后仍无任何会话）：用默认角色的内置教学开场白自动开启一段会话，
      // 让新手一进聊天页就能看到引导，而不是只有一张背景图或空状态。
      // 仅在「完全无会话」时执行：存量用户的会话/清空后自动补的空会话都不会被覆盖。
      if (!cancelled && !failed && Array.isArray(sessionList) && sessionList.length === 0) {
        try {
          const defaultCharacter = charactersRef.current.find(
            item => item.id === DEFAULT_CHARACTER.id
          );
          const firstMes = String((defaultCharacter && defaultCharacter.firstMes) || '').trim();
          if (firstMes) {
            let userName = '';
            try {
              const profile = await getUserProfile();
              userName = String((profile && profile.userName) || '').trim();
            } catch (error) {}
            const text = firstMes.replace(/\{\{user\}\}/g, () => userName || '用户');
            await ensureCharacterSession(DEFAULT_CHARACTER.id, { text, template: firstMes });
            // 标记「已自动展示」：与 ChatScreen 的兜底路径共用同一标记，
            // 用户日后清空会话也不会再被自动重开。
            await markDefaultGreetingShown().catch(() => {});
          }
        } catch (error) {
          // 自动开场白失败不影响主流程：聊天页会退回「选择开场白」空状态。
        }
      }
      if (!cancelled) {
        if (failed) {
          retryAttemptsRef.current += 1;
          if (retryAttemptsRef.current >= 5) {
            // 迁移反复失败不能无限静默重试：停下并明确告知，避免每次启动都空转。
            startedRef.current = true;
            Alert.alert(t('app.migration.failed.title'), t('app.migration.failed.body'));
          } else {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              setRetry(value => value + 1);
            }, 3000);
          }
        } else {
          startedRef.current = true;
        }
      }
      inFlightRef.current = false;
    })();
    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [loaded, retry, refreshSessions, ensureCharacterSession]);

  return null;
}

// 角色日记：过了一天之后的第一次启动，为开启日记的角色补写前一天的日记。
// 纯后台任务，失败静默（日记是增值功能，不影响启动与聊天）。
function DiaryStartup() {
  const { loaded } = useApp();
  const startedRef = useRef(false);

  // 冷启动路径：加载完成后跑一次（跨天闸门在 runDiaryIfNewDay 内判定）。
  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    runDiaryIfNewDay({ readSettings: getDiarySettings, run: runDiaryForNewDay }).catch(() => {});
  }, [loaded]);

  // 回前台补跑（2026-10-07）：App 常驻后台、热启动都不会走冷启动路径——只在
  // inactive/background → active 的跨天情况下再跑一次。runDiaryForNewDay 自带
  // running 互斥 + isNewDay 闸门，频繁切换前后台不会重复请求 API。
  useEffect(() => {
    if (!loaded) return undefined;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const cameToForeground = previous !== 'active' && next === 'active';
      previous = next;
      if (!cameToForeground) return;
      runDiaryIfNewDay({ readSettings: getDiarySettings, run: runDiaryForNewDay }).catch(() => {});
    });
    return () => subscription.remove();
  }, [loaded]);

  return null;
}

// 下载队列启动水合（v5 Stage B）：冷启动读持久化队列，把崩溃残留的 running 任务
// 恢复为 pending 并自动重下（断点重下）。与 UI 无关，挂载即跑一次。
function DownloadQueueStartup() {
  const { loaded } = useApp();
  const startedRef = useRef(false);
  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    hydrateDownloadQueue().catch(() => {});
  }, [loaded]);
  return null;
}

// 定时主动消息：通知点击（热启动走事件、冷启动走启动 intent）切换到对应角色并进入聊天页。
// 与上下文约定一致：切换失败回滚由 AppContext 负责，这里只提示，不在 context 层弹 UI。
function ProactiveMessageBridge({ navigationReady }) {
  const { t } = useTranslation();
  const { loaded, switchCharacter, switchSession, ingestProactiveMessages } = useApp();
  const pendingRoleRef = useRef(null);
  // 最近一轮落库得到的 roleId → sessionId 映射。冷启动时启动 effect 会先消费并 ack，
  // 事件路径（onOpenRole）随后再消费只能拿到空队列；若此时拿不到映射，就只切角色、
  // 停在默认会话，看不到落在另一段的新消息。缓存一份供后续 openRole 复用。
  const targetSessionRef = useRef({});
  // 消费互斥：启动 effect 与 onOpenRole 事件会在同一次进入时并发消费同一队列，
  // 先完成的一方 ack 清队列后另一方只能拿到空数组、丢失 targetSessions。共享同一
  // in-flight Promise，让并发调用复用同一次消费结果（含会话映射）。
  const ingestInFlightRef = useRef(null);

  // 消费原生待写队列：把到点时生成、但尚未写入会话的主动消息落库。
  // 只有写入成功的、以及永远无法处理的（结构残缺）才 ack 删除；
  // 角色暂时不在库或写入失败的**保留**，下次启动再试，绝不静默丢消息。
  // 返回本次每条消息实际落到的会话（roleId → sessionId），供跳转精确切段。
  const ingestPending = useCallback(() => {
    if (!loaded) return Promise.resolve({ targetSessions: {} });
    if (ingestInFlightRef.current) return ingestInFlightRef.current;
    const task = (async () => {
      const messages = await consumePendingMessages();
      if (messages.length === 0) return { targetSessions: {} };
      const { written, skipped, deferred, targetSessions } = await ingestProactiveMessages(messages);
      const acked = [...written, ...skipped];
      if (acked.length > 0) await ackPendingMessages(acked);
      const resolved = targetSessions || {};
      // 缓存落库得到的会话映射：队列已被本轮 ack 清空，后续 openRole 无法再取到，
      // 只能靠这份缓存精确切到消息所在会话。
      targetSessionRef.current = { ...targetSessionRef.current, ...resolved };
      // 诊断（release 可见）：记录一轮消费的结果，供「设置 → 关于 → 诊断日志」定位
      // 「通知发出但消息未落库」这类问题——区分取不到队列 / 角色不在库 / 写入失败。
      recordDiagnostic(
        'storage',
        `主动消息消费：取${messages.length} 写${written.length} 删${skipped.length} 缓${deferred.length}`,
        'proactive-ingest'
      );
      return { targetSessions: resolved };
    })();
    ingestInFlightRef.current = task;
    // 结束后清空，允许下一次（如回前台）重新消费。用 then 而非 await 保证引用同步可读。
    task.catch(() => {}).then(() => {
      if (ingestInFlightRef.current === task) ingestInFlightRef.current = null;
    });
    return task;
  }, [loaded, ingestProactiveMessages]);

  const openRole = useCallback(async (roleId, ingestResult = null) => {
    if (!roleId) return;
    // 加载/导航任一未就绪都先入队，避免在挂载完成前调用 navigate。
    //
    // 必须同时门控 loaded：loaded 前调 switchCharacter 会抛「角色尚未加载完成」，
    // 被 catch 吞掉后 roleId 既没入队、原生 pendingRoleId 也已在 drain 时清空
    // → roleId 消费一次即永久丢失（冷启动点通知不跳转的根因）。
    if (!loaded || !navigationReady || !navigationRef.isReady()) {
      pendingRoleRef.current = roleId;
      return;
    }
    try {
      // 先落库；落库会返回消息实际写入的会话 id。启动路径已消费过一轮的话直接复用，
      // 避免重复消费、也保证跳转用的是「刚落库那一段会话」而非再取一次的结果。
      const { targetSessions } = ingestResult || await ingestPending();
      await switchCharacter(roleId);
      // 精确切到消息实际落到的会话：只 switchCharacter + ensureCharacterSession 会取该角色
      // 的第一段会话，若消息落在另一段（衔接对话选了其它历史），就会停在旧会话看不到新消息。
      // 本轮落库拿不到映射时回退到本次运行缓存的映射（启动已 ack 的场景）。
      const targetSessionId = (targetSessions && targetSessions[roleId])
        || targetSessionRef.current[roleId];
      // 诊断（release 可见）：记录跳转是否命中消息所在会话——命中才会切段。
      recordDiagnostic(
        'storage',
        `主动消息跳转：角色${roleId} 目标会话${targetSessionId || '(无)'}`,
        'proactive-open'
      );
      if (targetSessionId) {
        // switchSession 内部读最新 sessionsRef，能命中刚落库新建的会话；
        // 会话不存在时静默忽略（switchCharacter 已切到该角色的会话）。
        await switchSession(targetSessionId).catch(() => {});
      }
      navigationRef.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert(t('app.openRole.failed.title'), t('app.openRole.failed.body'));
    }
  }, [loaded, navigationReady, switchCharacter, switchSession, ingestPending, t]);

  // 悬浮窗「说话」的 deep link（easychat2://screen-watch）：把用户带到「扩展 → 世界」
  // （看屏幕所在分组）。与 openRole 同一门控——导航未就绪时记住请求，就绪后补跳。
  const pendingScreenWatchRef = useRef(false);
  useEffect(() => {
    const handleUrl = ({ url }) => {
      if (!String(url || '').includes('screen-watch')) return;
      if (!loaded || !navigationReady || !navigationRef.isReady()) {
        pendingScreenWatchRef.current = true;
        return;
      }
      navigationRef.navigate(ROUTE_NAMES.extension, { segment: 'world' });
    };
    const subscription = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL()
      .then(url => {
        if (url) handleUrl({ url });
      })
      .catch(() => {});
    return () => subscription.remove();
  }, [loaded, navigationReady]);

  // 冷启动 / 后台唤起时导航容器可能尚未 ready：就绪后补跳一次。
  useEffect(() => {
    if (!pendingScreenWatchRef.current) return;
    if (!loaded || !navigationReady || !navigationRef.isReady()) return;
    pendingScreenWatchRef.current = false;
    navigationRef.navigate(ROUTE_NAMES.extension, { segment: 'world' });
  }, [loaded, navigationReady]);

  // 加载与导航都就绪后再消费排队中的角色。
  useEffect(() => {
    if (!loaded || !navigationReady || !pendingRoleRef.current) return;
    const roleId = pendingRoleRef.current;
    pendingRoleRef.current = null;
    openRole(roleId);
  }, [loaded, navigationReady, openRole]);

  useEffect(() => {
    if (!isProactiveMessageAvailable()) return undefined;
    if (loaded) {
      (async () => {
        try {
          // 启动即消费一轮：App 未打开期间到点的消息在这里补写进会话。
          // 结果直接交给 openRole，避免同一次启动再消费一遍（重复往返原生）。
          const ingestResult = await ingestPending();
          const roleId = await consumeInitialRole();
          if (roleId) await openRole(roleId, ingestResult);
        } catch (error) {
          // 原生模块读取失败时静默，不影响主流程
        }
      })();
    }
    const unsubscribe = addOpenRoleListener(openRole);
    return () => unsubscribe();
  }, [loaded, openRole, ingestPending]);

  // 热启动/返回前台补消费：到点时 App 可能只是切到后台（进程未死），通知点击虽会触发
  // onOpenRole，但用户「自己切回 App 看消息」这条路径没有任何消费入口——不补这一轮，
  // 后台到点的消息就会直到下次冷启动才落库（甚至永不落库）。回到前台消费一次即可。
  useEffect(() => {
    if (!isProactiveMessageAvailable() || !loaded) return undefined;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const cameToForeground = previous !== 'active' && next === 'active';
      previous = next;
      if (cameToForeground) ingestPending().catch(() => {});
    });
    return () => subscription.remove();
  }, [loaded, ingestPending]);

  return null;
}

// 本地 API 服务桥：把原生 HTTP 请求接到常驻本地模型，退后台/卸载时停服释放端口。
function LocalApiServerBridge() {
  useEffect(() => {
    if (!isLocalApiServerAvailable()) return undefined;
    const unsubscribe = attachLocalApiServerInference({
      runInference: async (messages, model, options = {}) => {
        const item = await getActiveLocalModel().catch(() => null);
        if (!item) throw new Error('No local model selected');
        const release = tryAcquireResource('local-model');
        if (!release) throw new Error('Local model is busy');
        try {
          // OpenAI 语义是无状态：每个请求用独立会话标识，跨请求必清 KV cache，
          // 避免上一个客户端请求的内容串进下一个请求。
          const result = await runLocalModel(messages, item, {
            conversationKey: `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            // v5 Stage D：把流式 token 透传给 API 服务器桥（stream=true 时逐片回写 SSE）。
            onToken: typeof options.onToken === 'function' ? options.onToken : undefined,
          });
          return result && typeof result.text === 'string' ? result.text : '';
        } finally {
          release();
        }
      },
    });
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (previous === 'active' && next !== 'active') {
        stopLocalApiServer().catch(() => {});
      }
      previous = next;
    });
    return () => {
      unsubscribe();
      subscription.remove();
      stopLocalApiServer().catch(() => {});
    };
  }, []);
  return null;
}

function TabBarIcon({ routeName, color, focused, palette }) {
  const [outline, filled] = TAB_ICONS[routeName] || ['ellipse-outline', 'ellipse'];
  const scale = useTabIconScale(focused);
  return (
    <View style={[styles.tabIconWrap, focused && styles.tabIconWrapActive, focused && {
      backgroundColor: palette.colors.primaryAlpha(0.18),
      borderColor: palette.colors.primaryMutedAlpha(0.35),
    }]}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Ionicons name={focused ? filled : outline} size={20} color={color} />
      </Animated.View>
    </View>
  );
}

function AppShell() {
  const { theme: palette, tokens } = useTheme();
  const { t } = useTranslation();
  // handleTabPress 是空依赖 useCallback：闭包 t 会在切换语言后继续用旧语言，
  // 经 ref 取当前值（与 useChatSend 的 tRef 同一模式）。
  const tRef = useRef(t);
  tRef.current = t;
  const [navigationReady, setNavigationReady] = useState(false);
  const navTheme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: palette.colors.background,
      card: palette.colors.background,
      text: palette.colors.text,
      border: palette.colors.surface,
      primary: palette.colors.primary,
    },
  };
  // 角色页有未保存编辑时拦截 Tab 切换：底部 Tab 页面保持挂载、切走不丢表单，
  // 但用户容易忘记保存导致修改不生效；确认框把「离开」变成顺手保存的入口。
  //
  // tabPress 事件的 target 是「路由 key」（形如 聊天-xxxx），不是路由名；
  // 而 navigationRef.navigate 只认路由名——直接把 key 传进去会静默 no-op，
  // 表现为点了「直接离开 / 保存并离开」都跳不走、每次切 Tab 又弹一次。
  // 因此先用根状态把 key 解析回路由名，再做比较与导航。
  const handleTabPress = useCallback(event => {
    const guard = getCharacterEditGuard();
    let currentName = '';
    try {
      currentName = String(navigationRef.current?.getCurrentRoute()?.name || '');
    } catch (error) {
      currentName = '';
    }
    let targetName = '';
    try {
      targetName = resolveTabName(navigationRef.getRootState(), event && event.target);
    } catch (error) {
      targetName = '';
    }
    if (!shouldConfirmTabLeave({ dirty: guard.dirty, currentName, targetName })) return;
    event.preventDefault();
    Alert.alert(
      tRef.current('app.tabLeave.title'),
      tRef.current('app.tabLeave.body'),
      [
        { text: tRef.current('app.tabLeave.stay'), style: 'cancel' },
        { text: tRef.current('app.tabLeave.leave'), onPress: () => navigationRef.navigate(targetName) },
        {
          text: tRef.current('app.tabLeave.saveAndLeave'),
          onPress: async () => {
            const saved = await guard.save();
            if (saved) navigationRef.navigate(targetName);
          },
        },
      ]
    );
  }, []);
  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onReady={() => setNavigationReady(true)}
    >
      <StatusBar style={palette.id === 'light' ? 'dark' : 'light'} />
      <ProactiveMessageBridge navigationReady={navigationReady} />
      <LocalApiServerBridge />
      <Header />
      <Tab.Navigator
        screenListeners={{ tabPress: handleTabPress }}
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: [styles.tabBar, {
            backgroundColor: palette.colors.surfaceAlt,
            borderTopColor: palette.colors.divider,
          }, tokens.elevation(2, palette)],
          tabBarActiveTintColor: palette.colors.primaryMuted,
          tabBarInactiveTintColor: palette.colors.textFaint,
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon routeName={route.name} color={color} focused={focused} palette={palette} />
          ),
        })}
      >
        {/* 路由名保持中文不动（值来自 src/navigation/routeNames.js）：它是内部标识符，被 navigate(ROUTE_NAMES.*) 等
            多处引用（含 App.js 的离页确认与各 Screen）。只翻译可见的 tabBarLabel，
            避免为 i18n 重命名路由带来的连锁改动风险。 */}
        <Tab.Screen name={ROUTE_NAMES.chat} component={ChatScreen} options={{ tabBarLabel: t('app.tab.chat') }} />
        <Tab.Screen name={ROUTE_NAMES.memory} component={MemoryScreen} options={{ tabBarLabel: t('app.tab.memory') }} />
        {/* 角色 Tab 现在是一个原生栈（角色库 ⇄ 角色详情），见 src/character/CharacterStack.js */}
        <Tab.Screen name={ROUTE_NAMES.character} component={CharacterStack} options={{ tabBarLabel: t('app.tab.character') }} />
        <Tab.Screen name={ROUTE_NAMES.extension} component={ExtensionScreen} options={{ tabBarLabel: t('app.tab.extension') }} />
        <Tab.Screen name={ROUTE_NAMES.settings} component={SettingsScreen} options={{ tabBarLabel: t('app.tab.settings') }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [startupReady, setStartupReady] = useState(false);
  const handleStartupReady = useCallback(() => setStartupReady(true), []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StartupErrorBoundary>
          <ThemeProvider>
            <I18nProvider>
              <AppProvider>
                {startupReady ? <AppShell /> : null}
                {startupReady ? <StartupSession /> : null}
                {startupReady ? <DiaryStartup /> : null}
                {startupReady ? <DownloadQueueStartup /> : null}
                <StartupFlow onReady={handleStartupReady} />
              </AppProvider>
            </I18nProvider>
          </ThemeProvider>
        </StartupErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  crashScreen: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  crashTitle: { color: '#ff9b9b', fontSize: 20, fontWeight: '800', marginBottom: 8 },
  crashHint: { color: '#c9c9e0', fontSize: 13, marginBottom: 12 },
  crashScroll: { flex: 1 },
  crashText: { color: '#e6e6f2', fontSize: 12, lineHeight: 18 },
  crashCopyButton: {
    marginTop: 12,
    marginBottom: 24,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#3a3a5c',
  },
  crashCopyText: { color: '#e6e6f2', fontSize: 14, fontWeight: '600' },
  header: {
    paddingBottom: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  logoBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  brandText: { justifyContent: 'center' },
  title: { fontWeight: '800', letterSpacing: 0.2 },
  subtitle: { marginTop: 3, letterSpacing: 2, fontWeight: '600' },
  tabBar: {
    borderTopWidth: 1,
    paddingTop: 6,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  tabLabel: { fontSize: 11, fontWeight: '600' },
  tabIconWrap: {
    width: 48,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
});
