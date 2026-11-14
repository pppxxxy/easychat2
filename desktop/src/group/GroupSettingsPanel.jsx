// 群聊设置（桌面）：群名 / 群头像 / 群背景 / 成员一览。
//
// 与手机的差异：手机把群设置并进了聊天顶栏的群编辑入口，桌面单独一个面板。
// 存储只用共享的 updateSessionInfo —— 它**只对群聊生效**，并会 markMediaWrite
// 保护刚写入的图片（备份导出后引用不会断）。
import { useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { setGroupMembers, setGroupMode, updateSessionInfo } from '../../../src/storage/sessionList.js';
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from '../../../src/chat/groupChat/groupLimits.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { Button, Field, Row, Select, TextInput } from '../settings/ui.jsx';

export default function GroupSettingsPanel({
  open,
  onClose,
  session,
  members,
  allCharacters,
  missingIds,
  palette,
  fonts,
  onSaved,
}) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = useState(session && session.name ? session.name : '');
  const [saving, setSaving] = useState(false);
  // 同步守卫：`saving` 是 state，同帧连点两次都会读到 false，第二次会用**旧快照**
  // 的 selectedIds 重算 next，把第一次的增删覆盖掉。ref 在同一帧立即生效。
  const savingRef = useRef(false);

  if (!open || !session) return null;

  const pickImage = async field => {
    const result = await getBridge().media.pick('image');
    const item = result && !result.canceled && result.items && result.items[0];
    if (!item) return;
    const ext = (item.uri.split('.').pop() || 'jpg').slice(0, 5);
    const destination = `${documentDirectory}characters/group-${field}-${Date.now()}.${ext}`;
    try {
      await getBridge().fs.copy(item.uri, destination);
      markMediaWrite(destination);
      const patch = field === 'avatar' ? { avatarUri: destination } : { bgUri: destination };
      const saved = await updateSessionInfo(session.id, patch);
      if (saved && typeof onSaved === 'function') onSaved(saved);
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    } finally {
      getBridge().fs.delete(item.uri, true).catch(() => {});
    }
  };

  // 发言方式（合议 / 轮流）：改了就落盘并让宿主刷新——它会改变发送链路的分支
  // （useChatSend 里 `groupMode !== 'turn'` 决定走合议还是轮流）。
  const changeMode = async mode => {
    if (savingRef.current || !session) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await setGroupMode(session.id, mode);
      if (saved && typeof onSaved === 'function') onSaved(saved);
      Alert.alert(t('group.mode.title'), t('group.mode.saved'));
    } catch (error) {
      Alert.alert(t('group.alert.saveFailed.title'), t('group.alert.saveFailed.body'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // 成员增删：勾选即改，改完立刻写回（与发言方式同一纪律：勾了就落盘）。
  // 上限校验在共享层 setGroupMembers（与创建时同一份常量），界面提前拦一道只为给出提示。
  const selectedIds = (Array.isArray(session && session.members) ? session.members : []).map(String);
  const toggleMember = async id => {
    if (savingRef.current) return;
    const target = String(id || '');
    if (!target) return;
    const next = selectedIds.includes(target)
      ? selectedIds.filter(item => item !== target)
      : [...selectedIds, target];
    if (next.length > MAX_GROUP_MEMBERS) {
      Alert.alert(t('character.library.group.limit.title'), t('character.library.group.limit.body'));
      return;
    }
    if (next.length < MIN_GROUP_MEMBERS) {
      Alert.alert(t('group.members.tooFew.title'), t('group.members.tooFew.body', { count: MIN_GROUP_MEMBERS }));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await setGroupMembers(session.id, next);
      if (saved && typeof onSaved === 'function') onSaved(saved);
    } catch (error) {
      Alert.alert(t('group.alert.saveFailed.title'), t('group.alert.saveFailed.body'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveName = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await updateSessionInfo(session.id, { name: String(nameDraft || '').trim() });
      if (saved && typeof onSaved === 'function') onSaved(saved);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 49,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(520px, 94vw)',
          maxHeight: '86vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('group.settings.title')}</strong>
          <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
        </div>

        <Row>
          {session.avatarUri ? (
            <img src={mediaUrl(session.avatarUri) || ''} alt="" style={{ width: 48, height: 48, borderRadius: 24, objectFit: 'cover' }} />
          ) : (
            <div style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              background: palette.surfaceAlt,
              color: palette.textMuted,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: fonts.scaled(16),
              fontWeight: 700,
            }}
            >
              {String(session.name || members[0] && members[0].name || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <Button label={t('character.library.group.avatarLabel')} onClick={() => pickImage('avatar')} palette={palette} fonts={fonts} />
          <Button label={t('character.library.group.bgLabel')} onClick={() => pickImage('bg')} palette={palette} fonts={fonts} />
        </Row>

        {/* 发言方式：两个模式在共享层是真实分支，不是展示开关。 */}
        <Field
          label={t('group.mode.title')}
          hint={session.groupMode === 'turn' ? t('group.mode.turnHint') : t('group.mode.ensembleHint')}
          palette={palette}
          fonts={fonts}
        >
          <Select
            value={session.groupMode === 'turn' ? 'turn' : 'ensemble'}
            options={[
              { value: 'ensemble', label: t('group.mode.ensemble') },
              { value: 'turn', label: t('group.mode.turn') },
            ]}
            onChange={changeMode}
            palette={palette}
            fonts={fonts}
            disabled={saving}
          />
        </Field>

        <Field label={t('character.library.group.nameLabel')} palette={palette} fonts={fonts}>
          <TextInput value={nameDraft} onChange={setNameDraft} palette={palette} fonts={fonts} />
        </Field>
        <Row>
          <Button
            label={saving ? t('backup.progress.ratio') : t('common.save')}
            onClick={saveName}
            palette={palette}
            fonts={fonts}
            primary
            disabled={saving}
          />
        </Row>

        <div style={{ borderTop: `1px solid ${palette.divider}`, paddingTop: 10 }}>
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, marginBottom: 6 }}>
            {t('character.library.group.selectMembers', { count: selectedIds.length })}
          </div>
          {/* 勾选即增删：全部角色都列出来，已选的打勾。 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
            {(Array.isArray(allCharacters) ? allCharacters : []).map(character => {
              const checked = selectedIds.includes(String(character.id));
              const atLimit = selectedIds.length >= MAX_GROUP_MEMBERS;
              const wouldBeTooFew = checked && selectedIds.length <= MIN_GROUP_MEMBERS;
              return (
                <label
                  key={character.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    borderRadius: 8,
                    cursor: saving ? 'default' : 'pointer',
                    background: checked ? palette.surfaceAlt : 'transparent',
                    opacity: (!checked && atLimit) || wouldBeTooFew ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving}
                    onChange={() => toggleMember(character.id)}
                  />
                  {character.avatarUri ? (
                    <img src={mediaUrl(character.avatarUri) || ''} alt="" style={{ width: 24, height: 24, borderRadius: 12, objectFit: 'cover' }} />
                  ) : (
                    <span style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      background: palette.surfaceAlt,
                      color: palette.textMuted,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: fonts.scaled(10),
                    }}
                    >
                      {String(character.name || '?').slice(0, 1)}
                    </span>
                  )}
                  <span style={{
                    fontSize: fonts.scaled(12),
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  >
                    {character.name || t('common.unnamedCharacter')}
                  </span>
                </label>
              );
            })}
          </div>
          {Array.isArray(missingIds) && missingIds.length > 0 ? (
            <div style={{ marginTop: 8, fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
              {t('group.members.missing', { count: missingIds.length })}
            </div>
          ) : null}
          <div style={{ marginTop: 6, fontSize: fonts.scaled(10), color: palette.textFaint }}>
            {t('character.library.group.count.body')}
          </div>
        </div>
      </div>
    </div>
  );
}
