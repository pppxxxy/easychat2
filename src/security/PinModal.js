// 密码输入弹窗：角色锁的「设置」与「验证」共用。
// set 模式：两次输入并本地校验一致性，另带一个可选的「密码提示」（写给自己的备忘）；
// verify 模式：单次输入，错误由调用方回传。

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  isValidPin,
  LOCK_HINT_MAX_LENGTH,
  normalizeLockHint,
  normalizePin,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
} from '../storage/security.js';

export default function PinModal({
  visible,
  mode = 'verify',
  title,
  subtitle,
  confirmLabel,
  cancelLabel,
  error,
  busy,
  // 是否显示「密码提示」输入（仅 set 有意义）。默认跟随 mode，
  // 显式传 false 可关掉（验证弹窗不该出现它）。
  showHint,
  onSubmit,
  onCancel,
}) {
  const { t } = useTranslation();
  const { theme, fonts, tokens } = useTheme();
  const styles = createStyles(theme, fonts, tokens);
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [localError, setLocalError] = useState('');
  const inputRef = useRef(null);
  const hintVisible = showHint === undefined ? mode === 'set' : showHint === true;

  useEffect(() => {
    if (!visible) return undefined;
    setValue('');
    setConfirm('');
    setHint('');
    setLocalError('');
    const timer = setTimeout(() => {
      if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus();
    }, 180);
    return () => clearTimeout(timer);
  }, [visible, mode]);

  const handleSubmit = () => {
    const pin = normalizePin(value);
    if (!isValidPin(pin)) {
      setLocalError(t('settings.security.pin.tooShort', { min: PIN_MIN_LENGTH }));
      return;
    }
    if (mode === 'set' && pin !== normalizePin(confirm)) {
      setLocalError(t('settings.security.pin.mismatch'));
      return;
    }
    setLocalError('');
    // hint 以字符串传给调用方（空串 = 用户没写）；要不要落库由调用方决定。
    if (typeof onSubmit === 'function') onSubmit(pin, hintVisible ? normalizeLockHint(hint) : undefined);
  };

  const shownError = error || localError;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={value}
            onChangeText={text => {
              setValue(normalizePin(text));
              setLocalError('');
            }}
            placeholder={t('settings.security.pin.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={PIN_MAX_LENGTH}
            editable={!busy}
          />
          {mode === 'set' ? (
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={text => {
                setConfirm(normalizePin(text));
                setLocalError('');
              }}
              placeholder={t('settings.security.pin.confirmPlaceholder')}
              placeholderTextColor={theme.colors.textFaint}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={PIN_MAX_LENGTH}
              editable={!busy}
            />
          ) : null}
          {hintVisible ? (
            <>
              {/* 密码提示：写给自己的备忘，忘记密码时可点角色行上的灯泡查看。
                  不参与校验、不进密码存储（另有 character_lock_hint_* 一条）。 */}
              <TextInput
                style={styles.hintInput}
                value={hint}
                onChangeText={text => setHint(text.slice(0, LOCK_HINT_MAX_LENGTH))}
                placeholder={t('settings.security.pin.hintPlaceholder')}
                placeholderTextColor={theme.colors.textFaint}
                maxLength={LOCK_HINT_MAX_LENGTH}
                editable={!busy}
              />
              <Text style={styles.hintNote}>{t('settings.security.pin.hintNote')}</Text>
            </>
          ) : null}
          {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.button, styles.ghostButton]}
              onPress={onCancel}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonText}>{cancelLabel || t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, busy && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
              ) : (
                <Text style={[styles.buttonText, styles.primaryButtonText]}>{confirmLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    sheet: {
      width: '100%',
      maxWidth: 360,
      borderRadius: 18,
      padding: 20,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      ...tokens.elevation(3, theme),
    },
    title: {
      color: theme.colors.text,
      fontSize: fonts.scaled(17),
      fontWeight: '800',
    },
    subtitle: {
      color: theme.colors.textMuted,
      fontSize: fonts.scaled(12),
      lineHeight: fonts.scaled(18),
      marginTop: 6,
    },
    input: {
      marginTop: 14,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      color: theme.colors.text,
      fontSize: fonts.scaled(20),
      letterSpacing: 6,
      textAlign: 'center',
    },
    hintInput: {
      marginTop: 10,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      color: theme.colors.text,
      fontSize: fonts.scaled(13),
    },
    hintNote: {
      marginTop: 6,
      color: theme.colors.textFaint,
      fontSize: fonts.scaled(11),
      lineHeight: fonts.scaled(15),
    },
    error: {
      marginTop: 10,
      color: theme.colors.danger,
      fontSize: fonts.scaled(12),
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: 18,
      gap: 10,
    },
    button: {
      minWidth: 92,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ghostButton: {
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonText: {
      color: theme.colors.text,
      fontSize: fonts.scaled(14),
      fontWeight: '700',
    },
    primaryButtonText: {
      color: theme.colors.primaryContrast,
    },
  });
}
