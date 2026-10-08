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
import { getSecuritySettings, subscribeSecuritySettings, verifyCharacterPasscode } from '../storage/security.js';
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
    try {
      settings = await getSecuritySettings();
    } catch (error) {
      settings = { appLock: { enabled: false, relockOnBackground: true }, characterLocks: {} };
    }
    setCharacterLocks(settings.characterLocks);
    appLockEnabledRef.current = settings.appLock.enabled;
    relockRef.current = settings.appLock.relockOnBackground;

    if (settings.appLock.enabled) {
      // 安全阀：设备后来移除了全部生物识别/锁屏凭据时，不把用户永久挡在门外。
      const availability = await getBiometricAvailability();
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
      return;
    }
    const cancelled = result.error === 'user_cancel'
      || result.error === 'system_cancel'
      || result.error === 'app_cancel';
    setAuthError(cancelled ? tRef.current('security.unlock.cancelled') : tRef.current('security.unlock.failed'));
  }, []);

  const runAppUnlockRef = useRef(runAppUnlock);
  runAppUnlockRef.current = runAppUnlock;

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
