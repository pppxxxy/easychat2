// 群聊设置（桌面）：群名 / 群头像 / 群背景 / 成员一览。
//
// 与手机的差异：手机把群设置并进了聊天顶栏的群编辑入口，桌面单独一个面板。
// 存储只用共享的 updateSessionInfo —— 它**只对群聊生效**，并会 markMediaWrite
// 保护刚写入的图片（备份导出后引用不会断）。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { updateSessionInfo } from '../../../src/storage/sessionList.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { Button, Field, Row, TextInput } from '../settings/ui.jsx';

export default function GroupSettingsPanel({
  open,
  onClose,
  session,
  members,
  missingIds,
  palette,
  fonts,
  onSaved,
}) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = useState(session && session.name ? session.name : '');
  const [saving, setSaving] = useState(false);

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

  const saveName = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await updateSessionInfo(session.id, { name: String(nameDraft || '').trim() });
      if (saved && typeof onSaved === 'function') onSaved(saved);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    } finally {
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
            {t('character.library.group.selectMembers', { count: members.length })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {members.map(member => (
              <div key={member.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {member.avatarUri ? (
                  <img src={mediaUrl(member.avatarUri) || ''} alt="" style={{ width: 24, height: 24, borderRadius: 12, objectFit: 'cover' }} />
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
                    {String(member.name || '?').slice(0, 1)}
                  </span>
                )}
                <span style={{ fontSize: fonts.scaled(12) }}>{member.name || t('common.unnamedCharacter')}</span>
              </div>
            ))}
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
