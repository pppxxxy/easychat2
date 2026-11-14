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
import { splitKeywords } from '../../../src/character/cardHelpers.js';
import { getUnsafeWorldEntryKeys } from '../../../src/prompt/lorebook.js';
import { createRegexScript } from '../../../src/character/cardParser/regexScripts.js';
import { isUnsafeRegexPattern } from '../../../src/prompt/regexEngine.js';
import { characterFormSignature } from '../../../src/character/cardHelpers.js';
import { makeCharacterPresetId } from '../../../src/character/characterPresets.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
// 导入到制卡：状态构造与草稿映射都用共享实现，桌面不重写。
import { createForgeState, draftFromCharacter } from '../../../src/cardForge/forge.js';
import { saveCardForge } from '../../../src/storage/cardForge.js';
import useDesktopCharacterDraft from './useDesktopCharacterDraft.js';
import { setCharacterEditGuard } from '../../../src/character/characterEditGuard.js';
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
  // 危险关键词（空串 / 通配 / 纯符号）会让条目在每轮都被触发或永不触发：与手机同一判据。
  const unsafeKeys = getUnsafeWorldEntryKeys(entry);
  const position = Number(entry.position) || 0;
  return (
    <div style={{ border: `1px solid ${palette.divider}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput
            value={entry.comment}
            onChange={value => patch({ comment: value })}
            placeholder={t('character.editor.world.namePlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button label={t('character.editor.delete')} onClick={onRemove} palette={palette} fonts={fonts} />
      </Row>
      <Field label={t('character.editor.world.keysLabel')} palette={palette} fonts={fonts}>
        <TextInput
          value={(entry.keys || []).join(', ')}
          onChange={value => patch({ keys: splitKeywords(value) })}
          placeholder={t('character.editor.world.keysPlaceholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      {unsafeKeys.length > 0 ? (
        <div style={{ fontSize: fonts.scaled(10), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {t('character.editor.world.unsafeKeys', { keys: unsafeKeys.join(', ') })}
        </div>
      ) : null}
      {/* 次要关键词：SillyTavern 的 secondary_keys，留空即不启用。 */}
      <Field label={t('character.editor.world.keysLabel')} hint={t('character.editor.world.keysPlaceholder')} palette={palette} fonts={fonts}>
        <TextInput
          value={(entry.secondaryKeys || []).join(', ')}
          onChange={value => patch({ secondaryKeys: splitKeywords(value) })}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Field label={t('character.editor.world.contentLabel')} palette={palette} fonts={fonts}>
        <MultiText
          value={entry.content}
          onChange={value => patch({ content: value })}
          placeholder={t('character.editor.world.contentPlaceholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Row>
        <Toggle
          checked={entry.constant === true}
          onChange={value => patch({ constant: value })}
          label={t('character.editor.world.constant')}
          palette={palette}
          fonts={fonts}
        />
        <Toggle
          checked={entry.enabled === true}
          onChange={value => patch({ enabled: value })}
          label={t('character.editor.enabled')}
          palette={palette}
          fonts={fonts}
        />
      </Row>
      <Row>
        <Field label={t('character.editor.world.position')} palette={palette} fonts={fonts}>
          <Select
            value={String(position)}
            options={WORLD_POSITION_LABELS.map((label, index) => ({ value: String(index), label: `${index} · ${label}` }))}
            // 只改 position，不落 positionLabel：那是当时语言下的文案，写进卡片会随导出传播。
            onChange={value => patch({ position: Number(value), positionLabel: '' })}
            palette={palette}
            fonts={fonts}
          />
        </Field>
        <Field label={t('character.editor.world.role')} palette={palette} fonts={fonts}>
          <Select
            value={entry.role}
            options={WORLD_ROLES.map(role => ({ value: role, label: role }))}
            onChange={value => patch({ role: value })}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      </Row>
      <Row>
        {/* 排序权重：同等命中时决定注入先后（手机 character.editor.order）。 */}
        <Field label={t('character.editor.order')} palette={palette} fonts={fonts}>
          <TextInput
            value={String(entry.order === undefined ? 100 : entry.order)}
            onChange={value => {
              const num = Number(value);
              patch({ order: Number.isFinite(num) ? num : 100 });
            }}
            palette={palette}
            fonts={fonts}
          />
        </Field>
        {/* depth 只在「按深度插入」位置（4）下有意义 —— 与手机同一可见性判据。 */}
        {position === 4 ? (
          <Field label={t('character.editor.depth')} palette={palette} fonts={fonts}>
            <TextInput
              value={String(entry.depth === undefined ? 4 : entry.depth)}
              onChange={value => {
                const num = Number(value);
                patch({ depth: Number.isFinite(num) ? num : 4 });
              }}
              palette={palette}
              fonts={fonts}
            />
          </Field>
        ) : null}
      </Row>
    </div>
  );
}

function RegexEditor({ script, palette, fonts, onChange, onRemove }) {
  const { t } = useTranslation();
  const patch = next => onChange({ ...script, ...next });
  // placement 是**数组**（一条正则可以同时作用于 AI 输出与用户输入）：
  // 手机用 chip 多选，桌面此前写成单选 [Number(value)]，选第二项会把第一项丢掉。
  const placement = Array.isArray(script.placement) ? script.placement : [1, 2];
  const togglePlacement = value => {
    const has = placement.includes(value);
    const next = has
      ? placement.filter(item => item !== value)
      : [...placement, value].sort((a, b) => a - b);
    // 只改 placement，不落 placementLabel：那是**当时语言下的文案**，写进卡片会随
    // 导出/分享传播（英文界面显示中文）。渲染侧按当前语言现算。
    patch({ placement: next, placementLabel: '' });
  };
  return (
    <div style={{ border: `1px solid ${palette.divider}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput
            value={script.name}
            onChange={value => patch({ name: value })}
            placeholder={t('character.editor.regex.namePlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button label={t('character.editor.delete')} onClick={onRemove} palette={palette} fonts={fonts} />
      </Row>
      <Field label={t('character.editor.regex.findLabel')} palette={palette} fonts={fonts}>
        <TextInput
          value={script.findRegex}
          onChange={value => patch({ findRegex: value })}
          placeholder={t('character.editor.regex.findPlaceholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      {/* 灾难性回溯的正则会让整条渲染卡死：与手机同一判据，输入时就提示。 */}
      {isUnsafeRegexPattern(script.findRegex) ? (
        <div style={{ fontSize: fonts.scaled(10), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {t('character.editor.regex.unsafeHint')}
        </div>
      ) : null}
      <Field label={t('character.editor.regex.replaceLabel')} palette={palette} fonts={fonts}>
        <TextInput
          value={script.replaceString}
          onChange={value => patch({ replaceString: value })}
          placeholder={t('character.editor.regex.replacePlaceholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Field label="flags" hint={t('character.editor.regex.flagsHint')} palette={palette} fonts={fonts}>
        <TextInput value={script.flags} onChange={value => patch({ flags: value })} palette={palette} fonts={fonts} />
      </Field>
      <Field label={t('character.editor.regex.scopeLabel')} hint={t('character.editor.regex.scopeHint')} palette={palette} fonts={fonts}>
        <Row>
          {REGEX_PLACEMENT_OPTIONS.map(option => {
            const active = placement.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => togglePlacement(option.value)}
                style={{
                  border: `1px solid ${active ? (palette.primaryMuted || palette.primary) : palette.divider}`,
                  background: active ? palette.surfaceAlt : 'transparent',
                  color: palette.text,
                  borderRadius: 999,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontSize: fonts.scaled(11),
                }}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </Row>
      </Field>
      <Row>
        <Toggle
          checked={script.enabled === true}
          onChange={value => patch({ enabled: value })}
          label={t('character.editor.enabled')}
          palette={palette}
          fonts={fonts}
        />
        <Toggle
          checked={script.markdownOnly === true}
          onChange={value => patch({ markdownOnly: value })}
          label={t('character.editor.regex.markdownOnly')}
          palette={palette}
          fonts={fonts}
        />
        <Toggle
          checked={script.promptOnly === true}
          onChange={value => patch({ promptOnly: value })}
          label={t('character.editor.regex.promptOnly')}
          palette={palette}
          fonts={fonts}
        />
      </Row>
    </div>
  );
}

export default function CharacterEditScreen({ character, palette, fonts, onSaved, onBack, onOpenForge }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [form, setForm] = useState(() => buildCharacterFormState(character));
  const [busy, setBusy] = useState(false);
  const baselineRef = useRef(JSON.stringify(buildCharacterFormState(character)));
  // dirty 需要「保存成功后立刻变 false」，而 baselineRef 是 ref（不触发重算）。
  // 用一个版本号参与 useMemo 依赖，保存后 bump 一次即可重算。
  const [baselineVersion, setBaselineVersion] = useState(0);
  const dirty = useMemo(
    () => JSON.stringify(form) !== baselineRef.current,
    // baselineVersion 是刻意的依赖：保存成功后 baseline 变了，需要重算 dirty。
    [form, baselineVersion]
  );

  useEffect(() => {
    const next = buildCharacterFormState(character);
    setForm(next);
    baselineRef.current = JSON.stringify(next);
  }, [character]);

  // 草稿恢复与暂存抽到 useDesktopCharacterDraft（本文件已到 800 行棘轮）。
  // 恢复时用 buildCharacterFormState 规范化：旧草稿可能缺字段，直接入表单会把
  // undefined 塞进输入框。
  const draft = useDesktopCharacterDraft({
    characterId: character ? character.id : '',
    form,
    dirty,
    baselineRef,
    onRestore: draftFormState => setForm(buildCharacterFormState({ ...character, ...draftFormState })),
    t,
  });

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
      // 并发冲突检测（与手机 CharacterDetailScreen 同款）：打开编辑页时记下角色的
      // 表单签名，保存时在**落库那一刻**再比一次。别处（另一个窗口/角色库快速操作）
      // 改过就把这次保存拦下，而不是静默覆盖对方的修改。
      const expected = characterFormSignature(character);
      const guarded = current => {
        if (characterFormSignature(current) !== expected) {
          const conflict = new Error(t('character.detail.conflict.body'));
          conflict.code = 'CHARACTER_CONFLICT';
          throw conflict;
        }
        return next;
      };
      guarded.id = character.id;
      await onSaved(guarded);
      baselineRef.current = JSON.stringify(form);
      // 让 dirty 立刻重算为 false（否则切 tab 仍会弹「未保存」）。
      setBaselineVersion(current => current + 1);
      // 保存成功即无「未保存的编辑」：草稿必须清掉，否则下次进来会问「恢复吗」。
      draft.clearDraft();
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      if (error && error.code === 'CHARACTER_CONFLICT') {
        Alert.alert(t('character.detail.conflict.title'), t('character.detail.conflict.body'));
      } else {
        Alert.alert(t('character.edit.alert.saveFailed.title'), t('character.edit.alert.saveFailed.body'));
      }
    } finally {
      setBusy(false);
    }
  };

  // 导入到制卡工坊：把当前角色读进制卡草稿，去「扩展 → 制卡」用 AI 继续改。
  // 与手机 CharacterDetailScreen.onImportToForge 同一套共享函数：
  //   createForgeState / draftFromCharacter（cardForge/forge/state.js + draft.js）
  // 差别只在导航方式：手机 push 到 ext-forge，桌面由宿主切到扩展页并指定二级路由。
  const importToForge = () => {
    if (!character) return;
    const apply = async () => {
      try {
        const fresh = createForgeState();
        await saveCardForge({
          ...fresh,
          draft: draftFromCharacter(characterWithFormState(character, form)),
          // 保留首题方便载入后继续点选项；引导语换成「从角色载入」的说明。
          transcript: [
            {
              id: `forge-${Date.now()}-from-character`,
              role: 'note',
              text: t('character.detail.forge.loadedNote', {
                name: form.name || t('common.unnamedCharacter'),
              }),
              createdAt: Date.now(),
            },
            ...fresh.transcript.slice(1),
          ],
          updatedAt: Date.now(),
        });
        if (typeof onOpenForge === 'function') onOpenForge();
      } catch (error) {
        Alert.alert(t('character.detail.forge.loadFailTitle'), t('common.error.storageOrPermission'));
      }
    };
    Alert.alert(
      t('character.detail.forge.title'),
      dirty ? t('character.detail.forge.bodyDirty') : t('character.detail.forge.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('character.detail.forge.continue'), onPress: apply },
      ]
    );
  };

  // 注册「未保存编辑」到共享信箱：宿主切换 tab 时读取它并拦截。
  // 与手机 App.js 的 tabPress 拦截共用同一份判定（characterEditGuard.js），
  // 桌面只是把「注册」放在编辑页挂载期、「读取」放在 tab 点击处。
  useEffect(() => {
    setCharacterEditGuard({ dirty, save: async () => { await save(); return true; } });
    return () => setCharacterEditGuard({ dirty: false });
  }, [dirty]);

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
            {typeof onOpenForge === 'function' ? (
              <Button
                label={t('character.detail.forge.entry')}
                onClick={importToForge}
                palette={palette}
                fonts={fonts}
              />
            ) : null}
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