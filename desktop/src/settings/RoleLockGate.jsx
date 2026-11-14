// 单角色锁的解锁闸门（桌面）。
//
// 没有这层，设置页里的「角色锁」就只是写了个密码——聊天页照样直接打开，锁形同虚设。
// 手机侧由 security/SecurityGate.js 在 App 顶层挡住整个聊天路由；桌面没有导航栈，
// 等价做法是把它挡在聊天面板**之前**（DesktopApp 渲染 ChatPane 时先过这道闸）。
//
// 判定与校验全部复用共享层 storage/security.js：
//   · getSecuritySettings —— 一次拿到 status + characterLocks。**状态未知必须被看见**：
//     此前这里用 isCharacterLocked().catch(() => false)，而它在数据损坏时返回 false——
//     于是「读不出来」被静默当成「没有上锁」，锁形同虚设。手机 SecurityGate 对未知态
//     是 fail-closed（阻挡 + 要求显式确认），桌面现在同样阻挡，但保留一个**显式**
//     「仍然继续」：桌面没有生物识别这把备用钥匙，无路可退时不能把人永久关在门外。
//   · verifyCharacterPasscode —— 常数时间比较，密码不存在明文。
//   · getCharacterLockHint —— 用户自设的提示，忘记密码时可见。
//
// 解锁状态按「角色 id」记账：切到没锁的角色不验证，切回上锁角色需重新输入。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  SECURITY_STATUS,
  getCharacterLockHint,
  getSecuritySettings,
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
  // 安全设置读不出来时不能当成「未上锁」：显式进入未知态，要求用户确认或重试。
  const [unknown, setUnknown] = useState(false);
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);

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
      getSecuritySettings().catch(() => null),
      getCharacterLockHint(characterId).catch(() => ''),
    ])
      .then(([settings, storedHint]) => {
        if (cancelled) return;
        // 读不到（抛错）也按未知处理——未知就是未知，不能降级成「没锁」。
        const status = settings ? settings.status : SECURITY_STATUS.UNKNOWN;
        setUnknown(status !== SECURITY_STATUS.OK && status !== SECURITY_STATUS.MISSING);
        setLocked(!!(settings && settings.characterLocks && settings.characterLocks[characterId]));
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

  // 状态未知：阻挡，给「重新读取」与一次**显式**继续（不是静默放行）。
  if (unknown && !unknownAcknowledged) {
    return (
      <section style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24,
        background: palette.background, color: palette.text,
      }}
      >
        <div style={{
          width: 'min(420px, 92vw)', border: `1px solid ${palette.divider}`,
          borderRadius: 14, padding: 20, background: palette.surface,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
        >
          <strong style={{ fontSize: fonts.scaled(15), color: palette.danger || '#ff5a5f' }}>
            {t('error.security.stateUnknownTitle')}
          </strong>
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.6 }}>
            {t('error.security.stateUnknownHint')}
          </div>
          <Button
            label={t('error.security.stateUnknownRetry')}
            onClick={() => {
              // 触发 effect 重跑：清掉 acknowledged 并切一次 loading。
              setUnknownAcknowledged(false);
              setChecking(true);
              setUnknown(false);
              setLocked(false);
              // 用微任务强制重新读取（依赖数组里只有 characterId，手动读一次）。
              getSecuritySettings()
                .then(settings => {
                  const status = settings ? settings.status : SECURITY_STATUS.UNKNOWN;
                  setUnknown(status !== SECURITY_STATUS.OK && status !== SECURITY_STATUS.MISSING);
                  setLocked(!!(settings && settings.characterLocks && settings.characterLocks[characterId]));
                })
                .catch(() => setUnknown(true))
                .finally(() => setChecking(false));
            }}
            palette={palette}
            fonts={fonts}
            primary
          />
          <Button
            label={t('error.security.stateUnknownContinue')}
            onClick={() => setUnknownAcknowledged(true)}
            palette={palette}
            fonts={fonts}
          />
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('error.security.stateUnknownNotice')}
          </div>
        </div>
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