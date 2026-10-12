// 隐私安全闸门：应用锁（生物识别）与单角色锁（密码）的统一入口。
//
// 设计动机：切换角色/会话的入口分散在角色库、聊天切换器、通知跳转等多处，
// 逐个改调用点既易漏又会把「验证」逻辑掺进业务代码。这里改成在 App 顶层放一个
// 覆盖层，观察「当前活跃会话属于哪个角色」，一旦命中加锁角色且当前在聊天页，
// 就用不透明覆盖层挡住内容并要求验证——所有入口都自然被覆盖。
//
// - 应用锁：冷启动、以及（可配置）从后台返回时上锁；生物识别失败可用系统密码兜底。
// - 单角色锁：仅在聊天路由下判定；换到别的角色再回来会重新验证（unlockedId 会随
//   目标角色变化重置）。提供「返回」以逃到未加锁的角色，避免忘记密码时被彻底困住。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useApp } from '../context/AppContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import { DEFAULT_CHARACTER } from '../storage/characters.js';
import {
  SECURITY_STATUS,
  getSecuritySettings,
  resolveAppLockPolicy,
  subscribeSecuritySettings,
  verifyCharacterPasscode,
} from '../storage/security.js';
import { authenticateBiometric, getBiometricAvailability } from './biometrics.js';
import PinModal from './PinModal.js';

export default function SecurityGate({ navigationRef }) {
  const { t } = useTranslation();
  const { theme, fonts, tokens } = useTheme();
  const {
    characters,
    activeId,
    sessions,
    activeSessionId,
    loaded,
    switchCharacter,
    ensureCharacterSession,
  } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // t 会随语言切换变化；经 ref 取当前值，避免把 t 放进依赖导致验证被反复触发。
  const tRef = useRef(t);
  tRef.current = t;

  const [securityLoaded, setSecurityLoaded] = useState(false);
  const [characterLocks, setCharacterLocks] = useState({});
  // 「状态未知」= 安全设置读损坏/读抛错：我们不知道有没有锁（三态见 storage/security.js）。
  // 这是**独立**于 appLocked 的一层拦截：即便应用锁因「设备没有可用验证手段」的安全阀
  // 落不下来，未知态也绝不允许静默放行。
  const [securityUnknown, setSecurityUnknown] = useState(false);
  // 未知态下用户已明确确认（验证通过 / 点了「仍然继续」）——本次会话内不再重复拦截。
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [routeName, setRouteName] = useState('');
  const [appLocked, setAppLocked] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [unlockedId, setUnlockedId] = useState('');
  const [charError, setCharError] = useState('');
  const [charBusy, setCharBusy] = useState(false);

  const appLockEnabledRef = useRef(false);
  const relockRef = useRef(true);
  const pendingRelockRef = useRef(false);
  const bootHandledRef = useRef(false);
  const lastSafeIdRef = useRef('');

  const loadSecurity = useCallback(async () => {
    let settings;
    let status;
    try {
      settings = await getSecuritySettings();
      status = settings.status;
    } catch (error) {
      // 读取本身抛错与「结构损坏」同类：**状态未知**。
      // 旧实现这里直接回落 `enabled: false`，等于把「读不出来」当成「没有锁」——
      // 数据还在（storage 层已备份原始值），保护却被丢弃，是典型的 fail-open。
      settings = { appLock: { enabled: false, relockOnBackground: true }, characterLocks: {} };
      status = SECURITY_STATUS.UNKNOWN;
    }
    // 三态判据集中在 resolveAppLockPolicy（纯函数，见 storage/security.js）：
    // 「未知」按最保守处理（要求验证），绝不静默放行。
    const policy = resolveAppLockPolicy(status, settings.appLock);
    setCharacterLocks(settings.characterLocks);
    setSecurityUnknown(policy.unknown);
    // 读到好数据就把「本次已确认未知」清掉：下次再损坏需要重新确认，不会一次确认永久放行。
    if (!policy.unknown) setUnknownAcknowledged(false);
    appLockEnabledRef.current = policy.requireUnlock;
    relockRef.current = policy.relockOnBackground;

    if (appLockEnabledRef.current) {
      // 安全阀：设备后来移除了全部生物识别/锁屏凭据时，不把用户永久挡在门外。
      // 注意这**不**等于「未知态放行」：securityUnknown 仍为真，下面的未知态拦截层
      // 照旧生效（它只提供「重试读取」与显式确认，不给静默通过）。
      const availability = await getBiometricAvailability();
      setBiometricAvailable(!!availability.available);
      if (!availability.available) {
        appLockEnabledRef.current = false;
        setAppLocked(false);
      } else if (!bootHandledRef.current) {
        setAppLocked(true);
      }
    } else {
      setAppLocked(false);
    }
    bootHandledRef.current = true;
    setSecurityLoaded(true);
  }, []);

  useEffect(() => {
    loadSecurity();
    const unsubscribe = subscribeSecuritySettings(() => {
      loadSecurity();
    });
    return () => unsubscribe();
  }, [loadSecurity]);

  // 从后台返回时按设置重新上锁。
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const wentBackground = previous === 'active' && next !== 'active';
      const cameToForeground = previous !== 'active' && next === 'active';
      previous = next;
      if (wentBackground && appLockEnabledRef.current && relockRef.current) {
        pendingRelockRef.current = true;
      }
      // 单角色锁：退到后台即视为离开，回到前台需要重新验证（与解锁状态同源重置）。
      if (wentBackground && !appLockEnabledRef.current) {
        setUnlockedId('');
      }
      if (cameToForeground && pendingRelockRef.current) {
        pendingRelockRef.current = false;
        if (appLockEnabledRef.current) setAppLocked(true);
      }
    });
    return () => subscription.remove();
  }, []);

  const runAppUnlock = useCallback(async () => {
    setAuthBusy(true);
    setAuthError('');
    const result = await authenticateBiometric({
      promptMessage: tRef.current('security.unlock.prompt'),
      cancelLabel: tRef.current('common.cancel'),
    });
    setAuthBusy(false);
    if (result.success) {
      setAuthError('');
      setAppLocked(false);
      // 设备主人已验证（生物识别/系统密码）：这与「应用锁解锁」等价，
      // 未知态不必再拦一层（否则刚验完又被状态未知层挡住，用户会觉得锁坏了）。
      setUnknownAcknowledged(true);
      return;
    }
    const cancelled = result.error === 'user_cancel'
      || result.error === 'system_cancel'
      || result.error === 'app_cancel';
    setAuthError(cancelled ? tRef.current('security.unlock.cancelled') : tRef.current('security.unlock.failed'));
  }, []);

  const runAppUnlockRef = useRef(runAppUnlock);
  runAppUnlockRef.current = runAppUnlock;

  // 「状态未知」层里的「重新读取」：回到「还没处理过启动」的状态再读一次，
  // 让 loadSecurity 重新判定要不要上锁（损坏数据被用户清理掉后就能自愈）。
  const retrySecurity = useCallback(() => {
    bootHandledRef.current = false;
    setUnknownAcknowledged(false);
    loadSecurity();
  }, [loadSecurity]);

  const acknowledgeUnknown = useCallback(() => {
    setUnknownAcknowledged(true);
  }, []);

  // 上锁事件触发一次验证（依赖刻意只放 securityLoaded/appLocked，避免重复弹窗）。
  useEffect(() => {
    if (!securityLoaded || !appLocked) return;
    if (!appLockEnabledRef.current) {
      setAppLocked(false);
      return;
    }
    runAppUnlockRef.current();
  }, [securityLoaded, appLocked]);

  // 跟踪当前路由：单角色锁只在聊天页生效（在设置页加锁时不会把自己锁住）。
  useEffect(() => {
    if (!navigationRef) return undefined;
    const update = () => {
      let name = '';
      try {
        name = navigationRef.isReady() ? String(navigationRef.getCurrentRoute()?.name || '') : '';
      } catch (error) {
        name = '';
      }
      setRouteName(name);
    };
    update();
    let unsubscribe = () => {};
    try {
      const subscription = navigationRef.addListener('state', update);
      if (typeof subscription === 'function') unsubscribe = subscription;
    } catch (error) {}
    return () => unsubscribe();
  }, [navigationRef]);

  // 当前会话所属角色（群聊不参与单角色锁）。
  const activeSession = sessions.find(session => session.id === activeSessionId) || null;
  const isGroupActive = activeSession ? activeSession.type === 'group' : false;
  const targetCharacterId = isGroupActive
    ? ''
    : String((activeSession && activeSession.characterId) || activeId || '');
  const targetLocked = !!targetCharacterId && characterLocks[targetCharacterId] === true;
  const showCharacterLock = securityLoaded
    && loaded
    && !!navigationRef
    && routeName === ROUTE_NAMES.chat
    && targetLocked
    && unlockedId !== targetCharacterId;

  // 目标角色变化时重置「本次已解锁」标记与错误：换走再回来需要重新验证。
  useEffect(() => {
    setUnlockedId('');
    setCharError('');
  }, [targetCharacterId]);

  // 记录最近一次「未加锁且正处于聊天页」的角色，作为验证弹层的逃生出口。
  useEffect(() => {
    if (!securityLoaded) return;
    if (targetCharacterId && !characterLocks[targetCharacterId]) {
      lastSafeIdRef.current = targetCharacterId;
    }
  }, [targetCharacterId, characterLocks, securityLoaded]);

  const fallbackCharacterId = useCallback(() => {
    const safe = lastSafeIdRef.current;
    if (safe && safe !== targetCharacterId
      && characters.some(item => item.id === safe) && !characterLocks[safe]) {
      return safe;
    }
    const firstUnlocked = characters.find(item => item.id !== targetCharacterId && !characterLocks[item.id]);
    if (firstUnlocked) return firstUnlocked.id;
    if (!characterLocks[DEFAULT_CHARACTER.id]) return DEFAULT_CHARACTER.id;
    return '';
  }, [characters, characterLocks, targetCharacterId]);

  const handleCharacterBack = useCallback(async () => {
    const target = fallbackCharacterId();
    if (!target) return;
    try {
      await switchCharacter(target);
      await ensureCharacterSession(target);
    } catch (error) {}
  }, [fallbackCharacterId, switchCharacter, ensureCharacterSession]);

  const handleCharacterSubmit = useCallback(async pin => {
    setCharBusy(true);
    setCharError('');
    const ok = await verifyCharacterPasscode(targetCharacterId, pin);
    setCharBusy(false);
    if (ok) {
      setUnlockedId(targetCharacterId);
      setCharError('');
      return;
    }
    setCharError(tRef.current('security.char.wrong'));
  }, [targetCharacterId]);

  // 加载期间先铺不透明底：应用锁开启时避免冷启动瞬间露出页面内容。
  if (!securityLoaded) {
    return <View style={[styles.fill, { backgroundColor: theme.colors.background }]} />;
  }

  if (appLocked && appLockEnabledRef.current) {
    return (
      <View style={[styles.fill, styles.lockBackdrop]}>
        <View style={styles.lockCard}>
          <View style={styles.lockIcon}>
            <Ionicons name="lock-closed" size={30} color={theme.colors.primary} />
          </View>
          <Text style={styles.lockTitle}>{t('security.unlock.title')}</Text>
          <Text style={styles.lockHint}>{t('security.unlock.hint')}</Text>
          {/* 状态未知时必须说清是「未知」而不是「未加锁」：用户看到的若是普通的
              「已锁定」，会以为设置被读错了；这里显式说明成因与本次的从严取舍。 */}
          {securityUnknown ? (
            <Text style={styles.lockWarn}>{t('error.security.stateUnknownNotice')}</Text>
          ) : null}
          {authError ? <Text style={styles.lockError}>{authError}</Text> : null}
          <TouchableOpacity
            style={[styles.unlockButton, authBusy && styles.buttonDisabled]}
            onPress={() => runAppUnlockRef.current()}
            disabled={authBusy}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('security.unlock.retry')}
          >
            {authBusy ? (
              <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            ) : (
              <Text style={styles.unlockButtonText}>{t('security.unlock.retry')}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // 状态未知拦截层：安全设置读不出来 ⇒ 我们不知道有没有锁。
  // 这里是**最后一道** fail-closed：即便上面的应用锁因「设备没有任何可用验证手段」的
  // 安全阀落不下来，也绝不放行——只给「重新读取」，以及一次**显式**确认
  //（生物识别可用时优先要求验证；连验证手段都没有时才给「仍然继续」，
  // 因为那种设备上「要求解锁」只会把用户自己永久关在门外）。
  // 关键区别：这是用户主动点出来的显式放行，不是静默把「未知」当成「未加锁」。
  if (securityUnknown && !unknownAcknowledged) {
    return (
      <View style={[styles.fill, styles.lockBackdrop]}>
        <View style={styles.lockCard}>
          <View style={styles.lockIcon}>
            <Ionicons name="help-circle-outline" size={30} color={theme.colors.danger} />
          </View>
          <Text style={styles.lockTitle}>{t('error.security.stateUnknownTitle')}</Text>
          <Text style={styles.lockHint}>{t('error.security.stateUnknownHint')}</Text>
          {authError ? <Text style={styles.lockError}>{authError}</Text> : null}
          <TouchableOpacity
            style={[styles.unlockButton, authBusy && styles.buttonDisabled]}
            onPress={biometricAvailable ? () => runAppUnlockRef.current() : retrySecurity}
            disabled={authBusy}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={biometricAvailable
              ? t('error.security.stateUnknownVerify')
              : t('error.security.stateUnknownRetry')}
          >
            {authBusy ? (
              <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            ) : (
              <Text style={styles.unlockButtonText}>
                {biometricAvailable
                  ? t('error.security.stateUnknownVerify')
                  : t('error.security.stateUnknownRetry')}
              </Text>
            )}
          </TouchableOpacity>
          {biometricAvailable ? (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={retrySecurity}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('error.security.stateUnknownRetry')}
            >
              <Text style={styles.secondaryButtonText}>{t('error.security.stateUnknownRetry')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={acknowledgeUnknown}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('error.security.stateUnknownContinue')}
            >
              <Text style={styles.secondaryButtonText}>{t('error.security.stateUnknownContinue')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  if (showCharacterLock) {
    const name = (characters.find(item => item.id === targetCharacterId) || {}).name || '';
    return (
      <View style={styles.fill}>
        {/* 不透明底：避免加锁角色的聊天内容透过弹窗背板被看到。 */}
        <View style={[styles.fill, { backgroundColor: theme.colors.background }]} />
        <PinModal
          visible
          mode="verify"
          title={t('security.char.title')}
          subtitle={t('security.char.hint', { name })}
          confirmLabel={t('security.char.unlock')}
          cancelLabel={t('security.char.back')}
          error={charError}
          busy={charBusy}
          onSubmit={handleCharacterSubmit}
          onCancel={handleCharacterBack}
        />
      </View>
    );
  }

  return null;
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    fill: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 1000,
      elevation: 1000,
    },
    lockBackdrop: {
      backgroundColor: theme.colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    },
    lockCard: {
      width: '100%',
      maxWidth: 360,
      alignItems: 'center',
      borderRadius: 20,
      padding: 28,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      ...tokens.elevation(3, theme),
    },
    lockIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      marginBottom: 16,
    },
    lockTitle: {
      color: theme.colors.text,
      fontSize: fonts.scaled(18),
      fontWeight: '800',
    },
    lockHint: {
      marginTop: 8,
      color: theme.colors.textMuted,
      fontSize: fonts.scaled(13),
      textAlign: 'center',
    },
    lockError: {
      marginTop: 12,
      color: theme.colors.danger,
      fontSize: fonts.scaled(12),
      textAlign: 'center',
    },
    // 「状态未知」的说明：与普通错误同色系但不抢解锁按钮的视觉焦点。
    lockWarn: {
      marginTop: 12,
      color: theme.colors.danger,
      fontSize: fonts.scaled(12),
      textAlign: 'center',
    },
    secondaryButton: {
      marginTop: 12,
      minWidth: 160,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      backgroundColor: theme.colors.surfaceAlt,
    },
    secondaryButtonText: {
      color: theme.colors.text,
      fontSize: fonts.scaled(13),
      fontWeight: '600',
    },
    unlockButton: {
      marginTop: 20,
      minWidth: 160,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    unlockButtonText: {
      color: theme.colors.primaryContrast,
      fontSize: fonts.scaled(14),
      fontWeight: '700',
    },
  });
}
