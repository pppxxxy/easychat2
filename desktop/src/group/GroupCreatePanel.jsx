// 创建群聊（桌面）：成员选择 2–8 人 + 群名 + 群头像/背景。
//
// 与手机 GroupCreateModal 同一套约束与文案；约束本身在 group/groupModel.js（可直测），
// 创建调用共享的 createGroupSession（与手机同一条存储路径、同一种会话形状）。
//
// 头像/背景的选择在桌面走 media.pick IPC，落盘到 documents/characters/ 并登记媒体保护
// （与角色编辑页同一做法），这样备份导出后图片不会丢。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { MAX_GROUP_MEMBERS } from '../../../src/chat/groupChat/groupLimits.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { Button, Field, Row, TextInput } from '../settings/ui.jsx';
import { groupMemberState, resolveGroupName, toggleGroupMember } from './groupModel.js';

function MemberAvatar({ character, palette, fonts }) {
  const src = useMemo(() => (character.avatarUri ? mediaUrl(character.avatarUri) : null), [character.avatarUri]);
  if (src) {
    return <img src={src} alt="" style={{ width: 32, height: 32, borderRadius: 16, objectFit: 'cover', flex: 'none' }} />;
  }
  return (
    <div style={{
      width: 32,
      height: 32,
      borderRadius: 16,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: palette.surfaceAlt,
      color: palette.textMuted,
      fontSize: fonts.scaled(12),
      fontWeight: 700,
    }}
    >
      {String(character.name || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

export default function GroupCreatePanel({
  open,
  onClose,
  characters,
  palette,
  fonts,
  busy,
  onCreate,
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState([]);
  const [name, setName] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [bgUri, setBgUri] = useState('');

  const state = groupMemberState(selected);
  if (!open) return null;

  const reset = () => {
    setSelected([]);
    setName('');
    setAvatarUri('');
    setBgUri('');
  };

  const pickImage = async field => {
    const result = await getBridge().media.pick('image');
    const item = result && !result.canceled && result.items && result.items[0];
    if (!item) return;
    const ext = (item.uri.split('.').pop() || 'jpg').slice(0, 5);
    const destination = `${documentDirectory}characters/group-${field}-${Date.now()}.${ext}`;
    try {
      await getBridge().fs.copy(item.uri, destination);
      markMediaWrite(destination);
      if (field === 'avatar') setAvatarUri(destination);
      else setBgUri(destination);
    } catch (error) {
      Alert.alert(t('character.edit.alert.readImageFailed.title'), t('character.edit.alert.readImageFailed.body'));
    } finally {
      getBridge().fs.delete(item.uri, true).catch(() => {});
    }
  };

  const toggle = id => {
    const before = selected;
    const next = toggleGroupMember(before, id);
    if (next === before && before.length >= MAX_GROUP_MEMBERS) {
      Alert.alert(t('character.library.group.limit.title'), t('character.library.group.limit.body'));
      return;
    }
    setSelected(next);
  };

  const submit = async () => {
    if (!state.canCreate) {
      Alert.alert(t('character.library.group.count.title'), t('character.library.group.count.body'));
      return;
    }
    const memberNames = characters
      .filter(character => selected.includes(character.id))
      .map(character => character.name || t('common.unnamedCharacter'));
    const finalName = resolveGroupName(name, memberNames, t('character.library.group.nameJoin'));
    const created = await onCreate({
      members: selected.slice(),
      name: finalName,
      avatarUri,
      bgUri,
    });
    if (created) reset();
  };

  return (
    <div style={{
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
      <div style={{
        width: 'min(560px, 94vw)',
        maxHeight: '88vh',
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
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('character.library.group.createTitle')}</strong>
          <Button label={t('common.cancel')} onClick={onClose} palette={palette} fonts={fonts} />
        </div>

        <Field label={t('character.library.group.nameLabel')} palette={palette} fonts={fonts}>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t('group.namePlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </Field>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button label={t('character.library.group.avatarLabel')} onClick={() => pickImage('avatar')} palette={palette} fonts={fonts} />
          {avatarUri ? (
            <>
              <img src={mediaUrl(avatarUri) || ''} alt="" style={{ width: 40, height: 40, borderRadius: 20, objectFit: 'cover' }} />
              <Button label={t('character.fields.image.clear')} onClick={() => setAvatarUri('')} palette={palette} fonts={fonts} />
            </>
          ) : null}
          <Button label={t('character.library.group.bgLabel')} onClick={() => pickImage('bg')} palette={palette} fonts={fonts} />
          {bgUri ? <Button label={t('character.fields.image.clear')} onClick={() => setBgUri('')} palette={palette} fonts={fonts} /> : null}
        </div>

        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
          {t('character.library.group.selectMembers', { count: state.count })}
        </div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
          {t('character.library.group.count.body')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflow: 'auto' }}>
          {characters.map(character => {
            const checked = selected.includes(character.id);
            return (
              <label
                key={character.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 10px',
                  borderRadius: 8,
                  cursor: state.atLimit && !checked ? 'not-allowed' : 'pointer',
                  background: checked ? palette.surfaceAlt : 'transparent',
                  border: `1px solid ${checked ? palette.primaryMuted : palette.divider}`,
                  opacity: state.atLimit && !checked ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(character.id)}
                  disabled={state.atLimit && !checked}
                />
                <MemberAvatar character={character} palette={palette} fonts={fonts} />
                <span style={{ fontSize: fonts.scaled(13), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {character.name || t('common.unnamedCharacter')}
                </span>
              </label>
            );
          })}
        </div>

        <Row>
          <Button
            label={busy ? t('character.library.group.creating') : t('character.library.group.create')}
            onClick={submit}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy || !state.canCreate}
          />
        </Row>
      </div>
    </div>
  );
}