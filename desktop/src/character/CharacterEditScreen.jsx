// 角色编辑页（桌面）：角色卡字段 + 世界书 + 正则脚本。
//
// 数据口径全部复用共享层：
//   · 表单初始值：buildCharacterFormState（与 Android 详情页同一份）
//   · 保存：characterWithFormState 会重算 systemPromptComposed（人设合成）
//   · 世界书/正则条目：createWorldEntry / createRegexScript 的归一化（含默认值语义）
// 头像/背景：选图后复制进 documents/avatars|characters 并登记媒体保护。
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildCharacterFormState,
  characterWithFormState,
} from '../../../src/character/cardHelpers.js';
import { createWorldEntry, WORLD_POSITION_LABELS } from '../../../src/character/cardParser/worldInfo.js';
import { createRegexScript } from '../../../src/character/cardParser/regexScripts.js';
import { makeCharacterPresetId } from '../../../src/character/characterPresets.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import CharacterOverrideCard from './CharacterOverrideCard.jsx';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { Button, Card, Divider, Field, Row, Select, TextInput, Toggle } from '../settings/ui.jsx';

const VOICE_MODES = ['text', 'voice-text', 'voice'];
const VOICE_LABELS = {
  text: 'character.fields.voice.text',
  'voice-text': 'character.fields.voice.voiceText',
  voice: 'character.fields.voice.voice',
};

// 正则作用范围（placement 数字与共享层一致：1=用户输入，2=AI 输出）。
const REGEX_PLACEMENT_OPTIONS = [
  { value: 1, labelKey: 'character.editor.regex.scope.userInput' },
  { value: 2, labelKey: 'character.editor.regex.scope.aiOutput' },
];

const WORLD_ROLES = ['system', 'user', 'assistant'];

function MultiText({ value, onChange, placeholder, palette, fonts, rows = 3 }) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={event => onChange(event.target.value)}
      rows={rows}
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
        width: '100%',
        boxSizing: 'border-box',
      }}
    />
  );
}

// 标签输入：回车/逗号添加，点 × 移除。
function TagsEditor({ tags, onChange, palette, fonts }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    if (!tags.includes(value)) onChange([...tags, value]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextInput
            value={draft}
            onChange={setDraft}
            placeholder={t('character.fields.tags.placeholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button
          label="+"
          onClick={commit}
          palette={palette}
          fonts={fonts}
        />
      </Row>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tags.map(tag => (
          <span
            key={tag}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 999,
              background: palette.surfaceAlt,
              border: `1px solid ${palette.divider}`,
              fontSize: fonts.scaled(11),
              color: palette.text,
            }}
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter(item => item !== tag))}
              style={{ background: 'transparent', border: 'none', color: palette.textFaint, cursor: 'pointer', padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function WorldEntryEditor({ entry, palette, fonts, onChange, onRemove }) {
  const { t } = useTranslation();
  const patch = next => onChange({ ...entry, ...next });
  return (
    <div style={{ border: `1px solid ${palette.divider}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput value={entry.comment} onChange={value => patch({ comment: value })} palette={palette} fonts={fonts} />
        </div>
        <Toggle checked={entry.enabled} onChange={value => patch({ enabled: value })} label="enabled" palette={palette} fonts={fonts} />
        <Button label="×" onClick={onRemove} palette={palette} fonts={fonts} />
      </Row>
      <Row>
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextInput
            value={(entry.keys || []).join(', ')}
            onChange={value => patch({ keys: value.split(/[,，\s]+/).filter(Boolean) })}
            placeholder={t('character.detail.world.metaKeywords', { keys: '' }).replace('：', '')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Toggle checked={entry.constant === true} onChange={value => patch({ constant: value })} label="constant" palette={palette} fonts={fonts} />
      </Row>
      <MultiText
        value={entry.content}
        onChange={value => patch({ content: value })}
        palette={palette}
        fonts={fonts}
      />
      <Row>
        <Field label="position" palette={palette} fonts={fonts}>
          <Select
            value={String(entry.position)}
            options={WORLD_POSITION_LABELS.map((label, index) => ({ value: String(index), label: `${index} · ${label}` }))}
            onChange={value => patch({ position: Number(value), positionLabel: WORLD_POSITION_LABELS[Number(value)] })}
            palette={palette}
            fonts={fonts}
          />
        </Field>
        <Field label="role" palette={palette} fonts={fonts}>
          <Select
            value={entry.role}
            options={WORLD_ROLES.map(role => ({ value: role, label: role }))}
            onChange={value => patch({ role: value })}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      </Row>
    </div>
  );
}

function RegexEditor({ script, palette, fonts, onChange, onRemove }) {
  const { t } = useTranslation();
  const patch = next => onChange({ ...script, ...next });
  return (
    <div style={{ border: `1px solid ${palette.divider}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput value={script.name} onChange={value => patch({ name: value })} palette={palette} fonts={fonts} />
        </div>
        <Toggle checked={script.enabled} onChange={value => patch({ enabled: value })} label="enabled" palette={palette} fonts={fonts} />
        <Button label="×" onClick={onRemove} palette={palette} fonts={fonts} />
      </Row>
      <Field label="find" palette={palette} fonts={fonts}>
        <TextInput value={script.findRegex} onChange={value => patch({ findRegex: value })} palette={palette} fonts={fonts} />
      </Field>
      <Field label="replace" palette={palette} fonts={fonts}>
        <TextInput value={script.replaceString} onChange={value => patch({ replaceString: value })} palette={palette} fonts={fonts} />
      </Field>
      <Row>
        <Field label="flags" palette={palette} fonts={fonts}>
          <TextInput value={script.flags} onChange={value => patch({ flags: value })} palette={palette} fonts={fonts} />
        </Field>
        <Field label="placement" palette={palette} fonts={fonts}>
          <Select
            value={String(script.placement[0] || 2)}
            options={REGEX_PLACEMENT_OPTIONS.map(option => ({ value: String(option.value), label: t(option.labelKey) }))}
            onChange={value => patch({ placement: [Number(value)] })}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      </Row>
    </div>
  );
}

export default function CharacterEditScreen({ character, palette, fonts, onSaved, onBack }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [form, setForm] = useState(() => buildCharacterFormState(character));
  const [busy, setBusy] = useState(false);
  const baselineRef = useRef(JSON.stringify(buildCharacterFormState(character)));
  const dirty = useMemo(() => JSON.stringify(form) !== baselineRef.current, [form]);

  useEffect(() => {
    const next = buildCharacterFormState(character);
    setForm(next);
    baselineRef.current = JSON.stringify(next);
  }, [character]);

  const patch = next => setForm(current => ({ ...current, ...next }));

  const pickImage = async field => {
    const result = await getBridge().media.pick('image');
    const item = result && !result.canceled && result.items && result.items[0];
    if (!item) return;
    const subdir = field === 'avatarUri' ? 'avatars' : 'characters';
    const destination = `${documentDirectory}${subdir}/${field === 'avatarUri' ? 'avatar' : 'bg'}-${Date.now()}.${(item.uri.split('.').pop() || 'jpg').slice(0, 5)}`;
    try {
      await getBridge().fs.copy(item.uri, destination);
      markMediaWrite(destination);
      patch({ [field]: destination });
    } catch (error) {
      Alert.alert(t('character.edit.alert.readImageFailed.title'), t('character.edit.alert.readImageFailed.body'));
    } finally {
      getBridge().fs.delete(item.uri, true).catch(() => {});
    }
  };

  const save = async () => {
    if (busy || !character) return;
    setBusy(true);
    try {
      const next = characterWithFormState(character, form);
      await onSaved(next);
      baselineRef.current = JSON.stringify(form);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      Alert.alert(t('character.edit.alert.saveFailed.title'), t('character.edit.alert.saveFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  if (!character) {
    return (
      <Card title={t('app.tab.character')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>{t('backup.card.noCharacter')}</div>
      </Card>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('character.edit.title')} palette={palette} fonts={fonts}>
        {typeof onBack === 'function' ? (
          <Row>
            <Button label={t('character.detail.back')} onClick={onBack} palette={palette} fonts={fonts} />
          </Row>
        ) : null}
        <Row>
          {form.avatarUri ? (
            <img src={mediaUrl(form.avatarUri) || ''} alt="" style={{ width: 64, height: 64, borderRadius: 32, objectFit: 'cover' }} />
          ) : (
            <span style={{ width: 64, height: 64, borderRadius: 32, background: palette.surfaceAlt, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.textMuted }}>
              {String(form.name || '?').slice(0, 1)}
            </span>
          )}
          {/* 无图时说「选择图片」，有图时说「更换」——与手机 ImagePickerRow 同一判据。
              否则空头像的角色上写着「更换」，用户会以为已经有一张看不见的图。 */}
          <Button
            label={form.avatarUri ? t('character.fields.image.change') : t('character.fields.image.pick')}
            onClick={() => pickImage('avatarUri')}
            palette={palette}
            fonts={fonts}
          />
          {form.avatarUri ? (
            <Button label={t('character.fields.image.clear')} onClick={() => patch({ avatarUri: '' })} palette={palette} fonts={fonts} />
          ) : null}
          <Button label={t('character.fields.bgLabel')} onClick={() => pickImage('bgUri')} palette={palette} fonts={fonts} />
          {form.bgUri ? (
            <Button label={t('character.fields.image.clear')} onClick={() => patch({ bgUri: '' })} palette={palette} fonts={fonts} />
          ) : null}
        </Row>

        <Field label={t('character.fields.name.label')} palette={palette} fonts={fonts}>
          <TextInput value={form.name} onChange={value => patch({ name: value })} placeholder={t('character.fields.name.placeholder')} palette={palette} fonts={fonts} />
        </Field>
        <Field label={t('character.fields.systemPrompt.label')} palette={palette} fonts={fonts}>
          <MultiText value={form.systemPrompt} onChange={value => patch({ systemPrompt: value })} placeholder={t('character.fields.systemPrompt.placeholder')} palette={palette} fonts={fonts} rows={4} />
        </Field>
        <Field label={t('character.fields.description.label')} palette={palette} fonts={fonts}>
          <MultiText value={form.description} onChange={value => patch({ description: value })} placeholder={t('character.fields.description.placeholder')} palette={palette} fonts={fonts} />
        </Field>
        <Row>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Field label={t('character.fields.personality.label')} palette={palette} fonts={fonts}>
              <MultiText value={form.personality} onChange={value => patch({ personality: value })} placeholder={t('character.fields.personality.placeholder')} palette={palette} fonts={fonts} rows={2} />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Field label={t('character.fields.scenario.label')} palette={palette} fonts={fonts}>
              <MultiText value={form.scenario} onChange={value => patch({ scenario: value })} placeholder={t('character.fields.scenario.placeholder')} palette={palette} fonts={fonts} rows={2} />
            </Field>
          </div>
        </Row>
        <Field label={t('character.fields.firstMes.label')} palette={palette} fonts={fonts}>
          <MultiText value={form.firstMes} onChange={value => patch({ firstMes: value })} placeholder={t('character.fields.firstMes.placeholder')} palette={palette} fonts={fonts} />
        </Field>
        <Field label={t('character.fields.mesExample.label')} hint={t('character.fields.mesExample.hint')} palette={palette} fonts={fonts}>
          <MultiText value={form.mesExample} onChange={value => patch({ mesExample: value })} placeholder={t('character.fields.mesExample.placeholder')} palette={palette} fonts={fonts} rows={4} />
        </Field>
        <Field label={t('character.fields.tags.label')} palette={palette} fonts={fonts}>
          <TagsEditor tags={form.tags} onChange={tags => patch({ tags })} palette={palette} fonts={fonts} />
        </Field>
        <Field label={t('character.fields.voice.label')} hint={t('character.fields.voice.hint')} palette={palette} fonts={fonts}>
          <Select
            value={form.voiceDisplay}
            options={VOICE_MODES.map(mode => ({ value: mode, label: t(VOICE_LABELS[mode]) }))}
            onChange={value => patch({ voiceDisplay: value })}
            palette={palette}
            fonts={fonts}
          />
        </Field>

        <Divider palette={palette} />

        <Field label={t('character.fields.greetings.label')} palette={palette} fonts={fonts}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {form.alternateGreetings.map((greeting, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <MultiText
                    value={greeting}
                    onChange={value => patch({
                      alternateGreetings: form.alternateGreetings.map((item, position) => (position === index ? value : item)),
                    })}
                    placeholder={t('character.fields.greetings.placeholder', { n: index + 1 })}
                    palette={palette}
                    fonts={fonts}
                    rows={2}
                  />
                </div>
                <Button
                  label="×"
                  onClick={() => patch({ alternateGreetings: form.alternateGreetings.filter((item, position) => position !== index) })}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            ))}
            <div>
              <Button
                label={t('character.fields.greetings.add')}
                onClick={() => patch({ alternateGreetings: [...form.alternateGreetings, ''] })}
                palette={palette}
                fonts={fonts}
              />
            </div>
          </div>
        </Field>

        <Divider palette={palette} />

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(12) }}>{t('character.detail.world.hint')}</strong>
          <Button
            label={t('character.detail.world.add')}
            onClick={() => patch({ worldInfo: [...form.worldInfo, createWorldEntry({}, form.worldInfo.length)] })}
            palette={palette}
            fonts={fonts}
          />
        </div>
        {form.worldInfo.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{t('character.detail.world.empty')}</div>
        ) : form.worldInfo.map((entry, index) => (
          <WorldEntryEditor
            key={entry.id}
            entry={entry}
            palette={palette}
            fonts={fonts}
            onChange={next => patch({
              worldInfo: form.worldInfo.map((item, position) => (position === index ? next : item)),
            })}
            onRemove={() => patch({ worldInfo: form.worldInfo.filter((item, position) => position !== index) })}
          />
        ))}

        <Divider palette={palette} />

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(12) }}>{t('character.detail.regex.hint')}</strong>
          <Button
            label={t('character.detail.regex.add')}
            onClick={() => patch({ regexScripts: [...form.regexScripts, createRegexScript({}, form.regexScripts.length)] })}
            palette={palette}
            fonts={fonts}
          />
        </div>
        {form.regexScripts.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{t('character.detail.regex.empty')}</div>
        ) : form.regexScripts.map((script, index) => (
          <RegexEditor
            key={script.id}
            script={script}
            palette={palette}
            fonts={fonts}
            onChange={next => patch({
              regexScripts: form.regexScripts.map((item, position) => (position === index ? next : item)),
            })}
            onRemove={() => patch({ regexScripts: form.regexScripts.filter((item, position) => position !== index) })}
          />
        ))}

        {/* 角色预设：只对这个角色生效的提示词片段（与全局预设互补）。 */}
        <Divider palette={palette} />
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(12) }}>{t('character.detail.presets.character')}</strong>
          <Button
            label={t('preset.add')}
            onClick={() => patch({
              presets: [...(Array.isArray(form.presets) ? form.presets : []), {
                id: makeCharacterPresetId(Array.isArray(form.presets) ? form.presets : []),
                name: '',
                description: '',
                prompt: '',
                enabled: true,
              }],
            })}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
          {t('character.detail.presets.hint')}
        </div>
        {(Array.isArray(form.presets) ? form.presets : []).map((preset, index) => (
          <div
            key={preset.id || `preset-${index}`}
            style={{
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <Row>
              <div style={{ flex: 1, minWidth: 140 }}>
                <TextInput
                  value={preset.name || ''}
                  onChange={value => patch({
                    presets: form.presets.map((item, position) => (
                      position === index ? { ...item, name: value } : item
                    )),
                  })}
                  placeholder={t('preset.editor.namePlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Toggle
                checked={preset.enabled !== false}
                onChange={value => patch({
                  presets: form.presets.map((item, position) => (
                    position === index ? { ...item, enabled: value } : item
                  )),
                })}
                label={t('preset.memory.title')}
                palette={palette}
                fonts={fonts}
              />
              <Button
                label={t('common.delete')}
                onClick={() => patch({ presets: form.presets.filter((_, position) => position !== index) })}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
              />
            </Row>
            <textarea
              value={preset.prompt || ''}
              onChange={event => patch({
                presets: form.presets.map((item, position) => (
                  position === index ? { ...item, prompt: event.target.value } : item
                )),
              })}
              placeholder={t('preset.editor.promptPlaceholder')}
              rows={3}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical',
                background: palette.surfaceAlt,
                color: palette.text,
                border: `1px solid ${palette.divider}`,
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: fonts.scaled(12),
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>
        ))}

        <Row>
          <Button
            label={busy ? t('backup.progress.ratio') : t('settings.persona.save')}
            onClick={save}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy}
          />
          {dirty ? (
            <span style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{t('settings.api.dirty.title')}</span>
          ) : null}
        </Row>
      </Card>
      {/* 专属配置（聊天 API）：与手机「专属配置」区同一语义，只保留桌面可用的那一项。 */}
      {character && character.id ? (
        <CharacterOverrideCard character={character} palette={palette} fonts={fonts} />
      ) : null}
    </div>
  );
}