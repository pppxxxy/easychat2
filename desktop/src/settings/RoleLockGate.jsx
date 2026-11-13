// 单角色锁的解锁闸门（桌面）。
//
// 没有这层，设置页里的「角色锁」就只是写了个密码——聊天页照样直接打开，锁形同虚设。
// 手机侧由 security/SecurityGate.js 在 App 顶层挡住整个聊天路由；桌面没有导航栈，
// 等价做法是把它挡在聊天面板**之前**（DesktopApp 渲染 ChatPane 时先过这道闸）。
//
// 判定与校验全部复用共享层 storage/security.js：
//   · isCharacterLocked —— 该角色是否在上锁名单（读坏时按 false，宁可放行也不误锁死；
//     手机 SecurityGate 对「状态未知」是**上锁**处理，桌面这里相反是刻意的：
//     桌面没有「忘记密码就换台设备」的退路，误锁会让用户彻底进不去自己的数据）。
//   · verifyCharacterPasscode —— 常数时间比较，密码不存在明文。
//   · getCharacterLockHint —— 用户自设的提示，忘记密码时可见。
//
// 解锁状态按「角色 id」记账：切到没锁的角色不验证，切回上锁角色需重新输入。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  getCharacterLockHint,
  isCharacterLocked,
  verifyCharacterPasscode,
} from '../../../src/storage/security.js';
import { Button, Field, TextInput } from '../settings/ui.jsx';

export default function RoleLockGate({ characterId, characterName, palette, fonts, children }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(true);
  const [locked, setLocked] = useState(false);
  const [unlockedId, setUnlockedId] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');

  // 换角色时重查锁状态（同一角色已解锁则保持放行）。
  useEffect(() => {
    let cancelled = false;
    if (!characterId) {
      setChecking(false);
      setLocked(false);
      return undefined;
    }
    setChecking(true);
    setError('');
    setPasscode('');
    Promise.all([
      isCharacterLocked(characterId).catch(() => false),
      getCharacterLockHint(characterId).catch(() => ''),
    ])
      .then(([isLocked, storedHint]) => {
        if (cancelled) return;
        setLocked(!!isLocked);
        setHint(String(storedHint || ''));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [characterId]);

  const unlock = useCallback(async () => {
    if (!characterId) return;
    const pin = String(passcode || '').replace(/\D/g, '');
    if (!pin) return;
    try {
      const ok = await verifyCharacterPasscode(characterId, pin);
      if (ok) {
        setUnlockedId(characterId);
        setPasscode('');
        setError('');
        return;
      }
    } catch (authError) {
      // 读密码失败（安全存储不可用）按验证失败处理，但不锁死界面。
    }
    setError(t('security.char.wrong'));
    setPasscode('');
  }, [characterId, passcode, t]);

  if (checking) {
    return (
      <section style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: palette.textMuted,
        fontSize: fonts.scaled(12),
      }}
      >
        {t('backup.progress.ratio')}
      </section>
    );
  }

  // 未上锁，或本次运行已为该角色解锁：直接渲染聊天面板。
  if (!locked || unlockedId === characterId) return children;

  return (
    <section style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 24,
      background: palette.background,
      color: palette.text,
    }}
    >
      <div style={{
        width: 'min(380px, 92vw)',
        border: `1px solid ${palette.divider}`,
        borderRadius: 14,
        padding: 20,
        background: palette.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
      >
        <strong style={{ fontSize: fonts.scaled(15) }}>{t('security.char.title')}</strong>
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.6 }}>
          {t('security.char.hint', { name: characterName || t('common.unnamedCharacter') })}
        </div>
        {hint ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
            {t('settings.security.pin.hintNote')}: {hint}
          </div>
        ) : null}
        <Field label={t('settings.security.pin.placeholder')} palette={palette} fonts={fonts}>
          <TextInput
            value={passcode}
            onChange={value => { setPasscode(String(value).replace(/\D/g, '').slice(0, 8)); setError(''); }}
            type="password"
            palette={palette}
            fonts={fonts}
          />
        </Field>
        {error ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{error}</div>
        ) : null}
        <Button
          label={t('security.char.unlock')}
          onClick={unlock}
          palette={palette}
          fonts={fonts}
          primary
          disabled={!passcode}
        />
      </div>
    </section>
  );
}