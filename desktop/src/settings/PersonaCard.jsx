// 用户人设卡：人设切换/新增/删除、名称与描述、头像。
//
// 存储复用 src/storage/personas.js（人设列表 + 活跃指针 + 全局头像），
// 写入全部走其内部串行队列，桌面这里只维护表单状态与「保存」动作。
import { useEffect, useRef, useState } from 'react';

import {
  createPersona,
  deletePersona,
  getActivePersonaId,
  getPersonas,
  getUserProfile,
  saveUserProfile,
  setActivePersonaId,
} from '../../../src/storage/personas.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { Button, Card, Field, Row, Select, TextInput } from './ui.jsx';

export default function PersonaCard({ palette, fonts }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [personas, setPersonas] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [profile, setProfile] = useState({ userName: '', persona: '', avatarUri: '' });
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  const load = async () => {
    const list = await getPersonas();
    const id = await getActivePersonaId(list);
    const current = await getUserProfile();
    if (!mountedRef.current) return;
    setPersonas(list);
    setActiveId(id);
    setProfile(current);
  };

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const run = async action => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(tRef.current('settings.profile.alert.saveFailed.title'),
          String((error && error.message) || tRef.current('settings.profile.alert.saveFailed.body')));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const save = () => run(async () => {
    await saveUserProfile({
      userName: String(profile.userName || ''),
      persona: String(profile.persona || ''),
      avatarUri: String(profile.avatarUri || ''),
    });
    Alert.alert(tRef.current('settings.api.saved.title'), tRef.current('settings.api.saved.body'));
  });

  const pickAvatar = async () => {
    const result = await getBridge().media.pick('image');
    const item = result && !result.canceled && result.items && result.items[0];
    if (item) {
      setProfile(current => ({ ...current, avatarUri: item.uri }));
    }
  };

  return (
    <Card title={t('settings.persona.title')} hint={t('settings.persona.hint')} palette={palette} fonts={fonts}>
      <Row>
        <Select
          value={activeId}
          options={personas.map((item, index) => ({
            value: item.id,
            label: item.userName || `${t('settings.persona.unnamed')} ${index + 1}`,
          }))}
          onChange={id => run(async () => {
            await setActivePersonaId(id);
          })}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
        <Button label={t('settings.persona.add')} onClick={() => run(async () => { await createPersona({}); })} palette={palette} fonts={fonts} disabled={busy} />
        <Button
          label={t('settings.persona.deleteCurrent')}
          onClick={() => run(async () => { await deletePersona(activeId); })}
          palette={palette}
          fonts={fonts}
          disabled={busy || personas.length <= 1}
        />
      </Row>

      <Row>
        {profile.avatarUri ? (
          <img
            src={mediaUrl(profile.avatarUri) || ''}
            alt=""
            style={{ width: 48, height: 48, borderRadius: 24, objectFit: 'cover', flex: 'none' }}
          />
        ) : (
          <span style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            background: palette.surfaceAlt,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: palette.textMuted,
            flex: 'none',
          }}
          >
            {t('settings.persona.avatarFallback')}
          </span>
        )}
        <Button label={t('settings.persona.changeAvatar')} onClick={pickAvatar} palette={palette} fonts={fonts} disabled={busy} />
        {profile.avatarUri ? (
          <Button
            label={t('settings.persona.clear')}
            onClick={() => setProfile(current => ({ ...current, avatarUri: '' }))}
            palette={palette}
            fonts={fonts}
          />
        ) : null}
      </Row>

      <Field label={t('settings.persona.name')} palette={palette} fonts={fonts}>
        <TextInput
          value={profile.userName}
          onChange={value => setProfile(current => ({ ...current, userName: value }))}
          placeholder={t('settings.persona.namePlaceholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Field label={t('settings.persona.description')} palette={palette} fonts={fonts}>
        <textarea
          value={profile.persona}
          onChange={event => setProfile(current => ({ ...current, persona: event.target.value }))}
          placeholder={t('settings.persona.descriptionPlaceholder')}
          rows={4}
          style={{
            background: palette.surfaceAlt,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: fonts.scaled(13),
            fontFamily: 'inherit',
            outline: 'none',
            resize: 'vertical',
          }}
        />
      </Field>
      <div>
        <Button
          label={busy ? t('backup.progress.ratio') : t('settings.persona.save')}
          onClick={save}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy}
        />
      </div>
    </Card>
  );
}

// 头像落盘（选图后调用）：把用户选择的图片复制到 documents/avatars/ 并登记保护。
// 与角色素材同目录，备份会自动带上。
export async function persistUserAvatar(sourceUri) {
  if (!sourceUri) return '';
  const destination = `${documentDirectory}avatars/user-${Date.now()}.png`;
  await getBridge().fs.copy(sourceUri, destination);
  markMediaWrite(destination);
  return destination;
}