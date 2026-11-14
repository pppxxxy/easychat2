// 制卡高级区块（桌面）：systemPrompt / 世界书 / 正则脚本 / 角色预设。
//
// 这四块此前在桌面**整块缺失**——桌面只渲染 FORGE_FIELDS 那 8 个文本字段 + tags，
// 生成/导入出来的世界书、正则、预设原样保留在草稿里（mergeDraft 不清），但用户
// 既看不到也改不了。手机 CardForgeEditor 有完整编辑区（约 300 行）。
//
// 复用共享层：
//   · createWorldEntry / createRegexScript / makeCharacterPresetId —— 条目构造（默认值语义）；
//   · sanitizeWorldEntry / sanitizeRegexScript / sanitizePreset —— 导入净化（与生成路径同源）；
//   · isUnsafeRegexPattern —— 灾难性回溯标记，与聊天引擎、advanced.js 共用同一判据。
// 本文件只做表单，不重写任何规则。
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { createRegexScript } from '../../../../src/character/cardParser/regexScripts.js';
import { createWorldEntry, WORLD_POSITION_LABELS } from '../../../../src/character/cardParser/worldInfo.js';
import { makeCharacterPresetId } from '../../../../src/character/characterPresets.js';
import { isUnsafeRegexPattern } from '../../../../src/prompt/regexEngine.js';
import { Button, Field, Row, TextInput, Toggle } from '../../settings/ui.jsx';

// 世界书位置的文案来自共享层（cardParser/worldInfo.js 的 WORLD_POSITION_LABELS），
// 这里不另造一份——两份中文迟早漂移，而且模块级硬编码中文会被 i18n 规则拦下。

export default function ForgeAdvancedPanels({ draft, onChange, palette, fonts }) {
  const { t } = useTranslation();
  const worldInfo = Array.isArray(draft.worldInfo) ? draft.worldInfo : [];
  const regexScripts = Array.isArray(draft.regexScripts) ? draft.regexScripts : [];
  const presets = Array.isArray(draft.presets) ? draft.presets : [];

  // 统一走「整草稿替换」：mapDraft 的不可变性由调用方 update 保证。
  const patchList = (key, mapper) => onChange({ ...draft, [key]: mapper(draft[key] || []) });
  const updateEntry = (key, index, next) => patchList(key, list => (
    list.map((item, position) => (position === index ? { ...item, ...next } : item))
  ));
  const removeEntry = (key, index) => patchList(key, list => (
    list.filter((item, position) => position !== index)
  ));

  const addWorld = () => {
    const id = `entry-${Date.now().toString(36)}`;
    patchList('worldInfo', list => [...list, createWorldEntry({
      id,
      comment: t('forge.newEntry.worldInfo', { n: list.length + 1 }),
    })]);
  };
  const addRegex = () => {
    const id = `regex-${Date.now().toString(36)}`;
    patchList('regexScripts', list => [...list, createRegexScript({
      id,
      name: t('forge.newEntry.regex', { n: list.length + 1 }),
    })]);
  };
  const addPreset = () => {
    // 字段名必须与手机/聊天注入一致：注入读 item.prompt、按 item.enabled 过滤。
    // 写成 content 只有在经过 normalizeCharacterPreset 时才会被映射成 prompt——
    // 而制卡草稿不经过 normalize（它直接被保存与发送），所以这里要写对原名。
    patchList('presets', list => [...list, {
      id: makeCharacterPresetId(list),
      name: t('forge.newEntry.preset', { n: list.length + 1 }),
      prompt: '',
      enabled: true,
    }]);
  };

  return (
    <>
      {/* systemPrompt：与 FORGE_FIELDS 分开（它是「系统提示词」而不是角色卡字段）。 */}
      <Field
        label={t('forge.systemPrompt.label')}
        hint={t('forge.systemPrompt.hint')}
        palette={palette}
        fonts={fonts}
      >
        <TextInput
          value={String(draft.systemPrompt || '')}
          onChange={value => onChange({ ...draft, systemPrompt: value })}
          placeholder={t('forge.systemPrompt.placeholder')}
          palette={palette}
          fonts={fonts}
        />
      </Field>

      {/* ---- 世界书 ---- */}
      <div style={{ borderTop: `1px solid ${palette.divider}`, paddingTop: 10 }}>
        <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{t('forge.world.groupLabel')}</div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('forge.world.groupHint')}
        </div>
        {worldInfo.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('forge.world.empty')}</div>
        ) : worldInfo.map((entry, index) => (
          <div key={entry.id || `world-${index}`} style={{ border: `1px solid ${palette.divider}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row>
              <div style={{ flex: 1, minWidth: 140 }}>
                <TextInput
                  value={String(entry.comment || '')}
                  onChange={value => updateEntry('worldInfo', index, { comment: value })}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Toggle
                checked={entry.enabled === true}
                onChange={value => updateEntry('worldInfo', index, { enabled: value })}
                label={t('forge.enabledLabel')}
                palette={palette}
                fonts={fonts}
              />
              <Button label={t('forge.delete')} onClick={() => removeEntry('worldInfo', index)} palette={palette} fonts={fonts} />
            </Row>
            <Field label={t('character.editor.world.keysLabel')} palette={palette} fonts={fonts}>
              <TextInput
                value={(entry.keys || []).join(', ')}
                onChange={value => updateEntry('worldInfo', index, {
                  keys: String(value || '').split(/[,，\s]+/).filter(Boolean),
                })}
                placeholder={t('character.editor.world.keysPlaceholder')}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <TextInput
              value={String(entry.content || '')}
              onChange={value => updateEntry('worldInfo', index, { content: value })}
              placeholder={t('character.editor.world.contentPlaceholder')}
              palette={palette}
              fonts={fonts}
            />
            <Toggle
              checked={entry.constant === true}
              onChange={value => updateEntry('worldInfo', index, { constant: value })}
              label={t('character.editor.world.constant')}
              palette={palette}
              fonts={fonts}
            />
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
              {t('character.editor.world.position', {
                label: WORLD_POSITION_LABELS[Number(entry.position) || 0] || WORLD_POSITION_LABELS[0],
              })}
            </div>
          </div>
        ))}
        <Button label={t('forge.world.add')} onClick={addWorld} palette={palette} fonts={fonts} />
      </div>

      {/* ---- 正则脚本 ---- */}
      <div style={{ borderTop: `1px solid ${palette.divider}`, paddingTop: 10 }}>
        <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{t('forge.regex.groupLabel')}</div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('forge.regex.groupHint')}
        </div>
        {regexScripts.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('forge.regex.empty')}</div>
        ) : regexScripts.map((script, index) => {
          const unsafe = isUnsafeRegexPattern(String(script.findRegex || ''));
          return (
            <div key={script.id || `regex-${index}`} style={{ border: `1px solid ${palette.divider}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Row>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <TextInput
                    value={String(script.name || '')}
                    onChange={value => updateEntry('regexScripts', index, { name: value })}
                    placeholder={t('forge.regex.namePlaceholder')}
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
                <Toggle
                  checked={script.enabled !== false}
                  onChange={value => updateEntry('regexScripts', index, { enabled: value })}
                  label={t('forge.enabledLabel')}
                  palette={palette}
                  fonts={fonts}
                />
                <Button label={t('forge.delete')} onClick={() => removeEntry('regexScripts', index)} palette={palette} fonts={fonts} />
              </Row>
              {/* 危险正则标记：引擎对它直接跳过（聊天里永不生效），这里必须可见。 */}
              {unsafe ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
                  {t('forge.regex.unsafeBadge')}
                </div>
              ) : null}
              <Row>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <TextInput
                    value={String(script.findRegex || '')}
                    onChange={value => updateEntry('regexScripts', index, { findRegex: value })}
                    placeholder={t('character.editor.regex.findPlaceholder')}
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <TextInput
                    value={String(script.replaceString || '')}
                    onChange={value => updateEntry('regexScripts', index, { replaceString: value })}
                    placeholder={t('character.editor.regex.replacePlaceholder')}
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
              </Row>
            </div>
          );
        })}
        <Button label={t('forge.regex.add')} onClick={addRegex} palette={palette} fonts={fonts} />
      </div>

      {/* ---- 角色预设 ---- */}
      <div style={{ borderTop: `1px solid ${palette.divider}`, paddingTop: 10 }}>
        <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{t('forge.preset.groupLabel')}</div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('forge.preset.groupHint')}
        </div>
        {presets.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('forge.preset.empty')}</div>
        ) : presets.map((preset, index) => (
          <div key={preset.id || `preset-${index}`} style={{ border: `1px solid ${palette.divider}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row>
              <div style={{ flex: 1, minWidth: 140 }}>
                <TextInput
                  value={String(preset.name || '')}
                  onChange={value => updateEntry('presets', index, { name: value })}
                  placeholder={t('forge.preset.namePlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Button label={t('forge.delete')} onClick={() => removeEntry('presets', index)} palette={palette} fonts={fonts} />
            </Row>
            <TextInput
              value={String(preset.prompt || '')}
              onChange={value => updateEntry('presets', index, { prompt: value })}
              placeholder={t('forge.preset.contentPlaceholder')}
              palette={palette}
              fonts={fonts}
            />
            {/* 启用开关：注入侧按 enabled !== false 过滤，关掉的预设不参与拼装。 */}
            <Toggle
              checked={preset.enabled !== false}
              onChange={value => updateEntry('presets', index, { enabled: value })}
              label={t('forge.enabledLabel')}
              palette={palette}
              fonts={fonts}
            />
          </div>
        ))}
        <Button label={t('forge.preset.add')} onClick={addPreset} palette={palette} fonts={fonts} />
      </div>
    </>
  );
}