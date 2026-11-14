// 单角色锁（桌面）：给某个角色设数字密码，打开它的聊天前要先输入。
//
// 为什么这个能移植而「应用锁」不能：应用锁走 expo-local-authentication（生物识别 +
// 系统锁屏），桌面没有等价硬件入口；单角色锁是**用户自设的数字密码**，密码落
// secretStore（桌面已用 Electron safeStorage 实现），校验是纯计算——与平台无关。
//
// 数据与判定全部复用共享层 storage/security.js：
//   · setCharacterLock / setCharacterLocks 先写密码再写名单（中途崩溃不会出现
//     「名单里有锁但读不到密码」）；
//   · verifyCharacterPasscode 供解锁用（桌面在 ChatPane 头部调用，见 RoleLockGate）；
//   · removeCharacterLock / getCharacterLockHint 负责移除与提示；
//   · 写路径有 requireSecurityForMutation 守卫：读坏时拒绝写（不清空上锁名单）。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  getCharacterLocks,
  removeCharacterLock,
  setCharacterLock,
  setCharacterLockHint,
  setCharacterLocks,
} from '../../../src/storage/security.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, TextInput } from './ui.jsx';

export default function CharacterLockCard({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters } = useApp();
  const [locks, setLocks] = useState(null);
  const [passcode, setPasscode] = useState('');
  const [hint, setHint] = useState('');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  // 批量上锁：手机是「多选 → 下一步统一设密码」两步；桌面把密码输入放在卡片顶部，
  // 所以两步合并成「勾选 → 应用当前密码」。判定一律走共享 setCharacterLocks——
  // 与单个上锁共用同一份存储布局与守卫（读坏时一个密码都不写）。
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const map = await getCharacterLocks();
      if (mountedRef.current) setLocks(map || {});
    } catch (error) {
      // 读坏时不冒充「没有任何角色上锁」：保持 null（界面显示读取失败），
      // 避免用户以为锁被清掉了。
      if (mountedRef.current) setLocks(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  const pinError = passcode && (String(passcode).length < PIN_MIN_LENGTH || String(passcode).length > PIN_MAX_LENGTH)
    ? t('settings.security.pin.tooShort', { min: PIN_MIN_LENGTH })
    : '';

  const apply = async id => {
    if (busyId) return;
    const pin = String(passcode || '').replace(/\D/g, '');
    if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
      Alert.alert(t('settings.security.title'), t('settings.security.pin.tooShort', { min: PIN_MIN_LENGTH }));
      return;
    }
    setBusyId(id);
    try {
      const ok = await setCharacterLock(id, pin);
      if (!ok) throw new Error('setCharacterLock returned false');
      if (hint) {
        // 提示是可选的；写失败不影响锁本身（读不到提示时界面回落成「需要密码」）。
        await setCharacterLockHint(id, hint).catch(() => {});
      }
      setPasscode('');
      setHint('');
      await load();
    } catch (error) {
      Alert.alert(t('settings.security.title'), t('common.error.storageOrPermission'));
    } finally {
      setBusyId('');
    }
  };

  const remove = character => {
    if (!character || busyId) return;
    Alert.alert(
      t('settings.security.removeLockTitle'),
      t('settings.security.removeLockMessage', { name: character.name || t('common.unnamedCharacter') }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.security.removeLockConfirm'),
          style: 'destructive',
          onPress: async () => {
            setBusyId(character.id);
            try {
              await removeCharacterLock(character.id);
              await load();
            } catch (error) {
              Alert.alert(t('settings.security.title'), t('common.error.storageOrPermission'));
            } finally {
              setBusyId('');
            }
          },
        },
      ]
    );
  };

  const list = (Array.isArray(characters) ? characters : [])
    .filter(character => !query || String(character.name || '').toLowerCase().includes(query.trim().toLowerCase()));

  // 只允许勾选「筛选后可见」的角色：否则全选会静默锁住搜索框外的人。
  const visibleIds = list.map(character => character.id).filter(Boolean);
  const selectedVisible = selectedIds.filter(id => visibleIds.includes(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleSelect = id => {
    setSelectedIds(current => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : visibleIds.slice());
  };

  const applyBulk = async () => {
    if (bulkBusy || selectedVisible.length === 0) return;
    const pin = String(passcode || '').replace(/\D/g, '');
    if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
      Alert.alert(t('settings.security.title'), t('settings.security.pin.tooShort', { min: PIN_MIN_LENGTH }));
      return;
    }
    setBulkBusy(true);
    try {
      // hint 语义照共享层：undefined = 不动原有提示；有值 = 统一覆盖这批角色。
      // 空串传 undefined 而不是 ''，避免把用户之前写的备忘清掉。
      const count = await setCharacterLocks(
        selectedVisible,
        pin,
        hint ? hint : undefined
      );
      if (!count) throw new Error('setCharacterLocks returned 0');
      setSelectedIds([]);
      setSelecting(false);
      setPasscode('');
      setHint('');
      await load();
      Alert.alert(t('settings.security.bulk.doneTitle'), t('settings.security.bulk.done', { count }));
    } catch (error) {
      Alert.alert(t('settings.security.title'), t('common.error.storageOrPermission'));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Card
      title={t('settings.security.title')}
      hint={t('settings.security.characterLocksHint')}
      palette={palette}
      fonts={fonts}
    >
      <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint, lineHeight: 1.6 }}>
        {t('desktop.security.appLockUnsupported')}
      </div>

      {locks === null ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
          {t('settings.security.appLockUnavailableTitle')}
        </div>
      ) : null}

      <Field label={t('settings.security.searchPlaceholder')} palette={palette} fonts={fonts}>
        <TextInput value={query} onChange={setQuery} palette={palette} fonts={fonts} />
      </Field>
      <Row>
        <div style={{ width: 130 }}>
          <TextInput
            value={passcode}
            onChange={value => setPasscode(String(value).replace(/\D/g, '').slice(0, PIN_MAX_LENGTH))}
            placeholder={t('settings.security.pin.placeholder')}
            palette={palette}
            fonts={fonts}
            type="password"
          />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput
            value={hint}
            onChange={setHint}
            placeholder={t('settings.security.pin.hintPlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
      </Row>
      {pinError ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{pinError}</div>
      ) : null}

      {/* 批量上锁工具条：手机是「多选 → 下一步统一设密码」两步弹层；
          桌面密码就在上面输入，所以合并为「勾选 → 应用到选中」。 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        borderBottom: `1px solid ${palette.divider}`,
        paddingBottom: 8,
      }}
      >
        {selecting ? (
          <>
            <Button
              label={allSelected
                ? t('settings.security.bulk.clearAll')
                : t('settings.security.bulk.selectAll')}
              onClick={toggleSelectAll}
              palette={palette}
              fonts={fonts}
            />
            <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {t('settings.security.bulk.selected', { count: selectedVisible.length })}
            </span>
            <Button
              label={t('settings.security.bulk.next')}
              onClick={applyBulk}
              palette={palette}
              fonts={fonts}
              disabled={bulkBusy || selectedVisible.length === 0 || !!pinError || !passcode}
            />
            <Button
              label={t('common.cancel')}
              onClick={() => {
                setSelecting(false);
                setSelectedIds([]);
              }}
              palette={palette}
              fonts={fonts}
            />
          </>
        ) : (
          <Button
            label={t('settings.security.bulk.title')}
            onClick={() => {
              setSelecting(true);
              setSelectedIds([]);
            }}
            palette={palette}
            fonts={fonts}
          />
        )}
      </div>

      {list.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('settings.security.searchEmpty')}</div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map(character => {
          const locked = !!(locks && locks[character.id]);
          const checked = selectedIds.includes(character.id);
          return (
            <div
              key={character.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: `1px solid ${checked ? palette.primaryMuted || palette.primary : palette.divider}`,
                borderRadius: 8,
                padding: '6px 10px',
              }}
            >
              {selecting ? (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSelect(character.id)}
                  aria-label={`${character.name || t('common.unnamedCharacter')} ${t('settings.security.bulk.title')}`}
                />
              ) : null}
              <span style={{ flex: 1, minWidth: 0, fontSize: fonts.scaled(12), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {character.name || t('common.unnamedCharacter')}
              </span>
              <span style={{
                fontSize: fonts.scaled(10),
                color: locked ? (palette.primaryMuted || palette.primary) : palette.textFaint,
                flex: 'none',
              }}
              >
                {locked ? t('settings.security.locked') : t('settings.security.unlocked')}
              </span>
              {locked ? (
                <Button
                  label={t('settings.security.removeLockConfirm')}
                  onClick={() => remove(character)}
                  palette={palette}
                  fonts={fonts}
                  tone={palette.danger || '#ff5a5f'}
                  disabled={busyId === character.id}
                />
              ) : selecting ? null : (
                <Button
                  label={t('settings.security.appLockPrompt')}
                  onClick={() => apply(character.id)}
                  palette={palette}
                  fonts={fonts}
                  disabled={!passcode || pinError || busyId === character.id}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}