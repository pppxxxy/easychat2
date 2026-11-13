// 主动消息（桌面）：配置「角色在哪个时间点主动发一条消息」。
//
// 与手机 ProactivePanel 同一份数据（storage/moments.js 的 PROACTIVE_SETTINGS_KEY）：
//   slots[] 每个槽 = 角色 + 时间 + 时段长度 + 模式 + 风格权重表 + 衔接会话。
//
// **桌面只做配置，不负责定时触发**：手机侧靠 WorkManager / 前台服务在后台唤起；
// 桌面进程退出后没有等价载体（这条已如实写在扩展页的「依赖手机系统的能力」里）。
// 但配置是可移植的——用户在桌面配好，手机端（或桌面开着时的启动补跑）就能用；
// 反过来手机配好的也能在桌面查看/修改。
//
// 保存走 saveProactiveSettings：它内部串行入队 + 读失败拒绝整键覆盖
// （读坏时「当前设置」是 {slots: []}，直接写回会把用户每个角色的时段全清）。
import { useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { getApiConfigs } from '../../../../src/storage/apiConfigs.js';
import {
  PROACTIVE_MESSAGE_TYPES,
  PROACTIVE_MODES,
  getProactiveSettings,
  makeProactiveSlotId,
  normalizeProactiveWindowMinutes,
  saveProactiveSettings,
} from '../../../../src/storage/moments.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row, Select, TextInput, Toggle } from '../../settings/ui.jsx';

const MODE_LABELS = {
  WORK: 'proactive.mode.work',
  EXACT: 'proactive.mode.exact',
};

const TYPE_LABELS = {
  DEFAULT: 'proactive.type.default',
  CARE: 'proactive.type.care',
  GREETING: 'proactive.type.greeting',
  CUSTOM: 'proactive.type.custom',
};

export default function ProactiveScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters, sessions } = useApp();
  const [settings, setSettings] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getProactiveSettings(),
      getApiConfigs().catch(() => ({ configs: [] })),
    ])
      .then(([stored, api]) => {
        if (cancelled) return;
        setSettings(stored);
        setConfigs(Array.isArray(api.configs) ? api.configs : []);
      })
      .catch(() => {
        if (!cancelled) setSettings({ slots: [], apiConfigId: '', model: '' });
      })
      .then(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // 「衔接的历史对话」下拉：按角色筛出可衔接的单聊会话（群聊不支持主动消息）。
  const sessionOptions = useMemo(() => {
    const list = Array.isArray(sessions) ? sessions : [];
    return list
      .filter(item => item && item.type !== 'group')
      .map(item => {
        const owner = (Array.isArray(characters) ? characters : []).find(character => character.id === item.characterId);
        const label = String(item.name || item.preview || '').trim() || t('proactive.session.empty');
        return { value: item.id, label: `${String((owner && owner.name) || '')} · ${label}` };
      });
  }, [sessions, characters, t]);

  const characterOptions = useMemo(() => (Array.isArray(characters) ? characters : [])
    .map(item => ({ value: item.id, label: item.name || t('common.unnamedCharacter') })), [characters, t]);

  const configOptions = useMemo(() => [
    { value: '', label: t('diary.apiDefaultShort') },
    ...configs.map(item => ({ value: item.id, label: item.name || t('settings.api.unnamed') })),
  ], [configs, t]);

  const patchSlot = (index, patch) => {
    setSettings(current => {
      if (!current) return current;
      const slots = current.slots.map((slot, position) => (position === index ? { ...slot, ...patch } : slot));
      return { ...current, slots };
    });
  };

  const addSlot = () => {
    setSettings(current => {
      if (!current) return current;
      const first = characterOptions[0];
      if (!first) return current;
      const slot = {
        slotId: makeProactiveSlotId(),
        roleId: first.value,
        roleName: '',
        persona: '',
        hour: 9,
        minute: 0,
        windowMinutes: 0,
        mode: 'WORK',
        enabled: true,
        apiConfigId: '',
        model: '',
        revision: '',
        styles: [{ messageType: 'DEFAULT', customPrompt: '', weight: 1 }],
        messageType: 'DEFAULT',
        customPrompt: '',
        sessionTargetId: '',
      };
      return { ...current, slots: [...current.slots, slot] };
    });
  };

  const removeSlot = index => {
    setSettings(current => {
      if (!current) return current;
      return { ...current, slots: current.slots.filter((_, position) => position !== index) };
    });
  };

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const saved = await saveProactiveSettings(settings);
      setSettings(saved);
      Alert.alert(t('settings.api.saved.title'), t('proactive.notice.saved', { n: saved.slots.length }));
    } catch (error) {
      // 读失败守卫会抛错：此时绝不能假装保存成功（那会让用户以为配置还在）。
      Alert.alert(t('proactive.notice.saveFailed'), t('proactive.notice.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('proactive.title')} hint={t('proactive.intro')} palette={palette} fonts={fonts}>
        {loading ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : (
          <>
            <div style={{
              fontSize: fonts.scaled(11),
              color: palette.primaryMuted || palette.primary,
              lineHeight: 1.7,
            }}
            >
              {t('desktop.proactive.desktopOnlyHint')}
            </div>
            <Field label={t('proactive.sourceLabel')} palette={palette} fonts={fonts}>
              <Select
                value={settings.apiConfigId || ''}
                options={configOptions}
                onChange={value => setSettings(current => ({ ...current, apiConfigId: value }))}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Row>
              <Button label={t('proactive.slots.add')} onClick={addSlot} palette={palette} fonts={fonts} disabled={characterOptions.length === 0} />
              <Button
                label={saving ? t('diary.saving') : t('common.save')}
                onClick={save}
                palette={palette}
                fonts={fonts}
                primary
                disabled={saving}
              />
            </Row>
            {characterOptions.length === 0 ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.noRoles')}</div>
            ) : null}
            {settings.slots.length === 0 ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('proactive.slots.empty')}</div>
            ) : null}
          </>
        )}
      </Card>

      {settings && settings.slots.map((slot, index) => (
        <Card
          key={slot.slotId}
          palette={palette}
          fonts={fonts}
          title={String((characters.find(item => item.id === slot.roleId) || {}).name || t('proactive.default.roleName'))}
        >
          <Toggle
            checked={slot.enabled !== false}
            onChange={value => patchSlot(index, { enabled: value })}
            label={t('schedule.enable')}
            palette={palette}
            fonts={fonts}
          />
          <Row>
            <Field label={t('schedule.selectRole')} palette={palette} fonts={fonts}>
              <Select
                value={slot.roleId}
                options={characterOptions}
                onChange={value => patchSlot(index, { roleId: value })}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Field label={t('schedule.segments.start')} palette={palette} fonts={fonts}>
              <div style={{ width: 76 }}>
                <TextInput
                  value={String(slot.hour).padStart(2, '0')}
                  onChange={value => {
                    const parsed = Math.trunc(Number(value));
                    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 23) patchSlot(index, { hour: parsed });
                  }}
                  type="number"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            </Field>
            <Field label="mm" palette={palette} fonts={fonts}>
              <div style={{ width: 76 }}>
                <TextInput
                  value={String(slot.minute).padStart(2, '0')}
                  onChange={value => {
                    const parsed = Math.trunc(Number(value));
                    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 59) patchSlot(index, { minute: parsed });
                  }}
                  type="number"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            </Field>
            <Field label={t('proactive.window.label')} palette={palette} fonts={fonts}>
              <div style={{ width: 84 }}>
                <TextInput
                  value={String(slot.windowMinutes || 0)}
                  onChange={value => {
                    const parsed = Math.trunc(Number(value));
                    if (Number.isFinite(parsed)) {
                      patchSlot(index, { windowMinutes: normalizeProactiveWindowMinutes(parsed) });
                    }
                  }}
                  type="number"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            </Field>
          </Row>
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
            {t('proactive.weight.hint')}
          </div>

          <Row>
            <Field label={t('proactive.mode.work')} palette={palette} fonts={fonts}>
              <Select
                value={slot.mode}
                options={PROACTIVE_MODES.map(mode => ({ value: mode, label: t(MODE_LABELS[mode] || 'proactive.type.default') }))}
                onChange={value => patchSlot(index, { mode: value })}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Field label={t('proactive.session.label')} palette={palette} fonts={fonts}>
              <Select
                value={slot.sessionTargetId || ''}
                options={[
                  { value: '', label: t('proactive.session.new') },
                  ...(Array.isArray(sessionOptions) ? sessionOptions : []),
                ]}
                onChange={value => patchSlot(index, { sessionTargetId: value })}
                palette={palette}
                fonts={fonts}
              />
            </Field>
          </Row>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>{t('proactive.weight.label')}</span>
            {(Array.isArray(slot.styles) ? slot.styles : []).map((style, styleIndex) => (
              <Row key={`${slot.slotId}-style-${styleIndex}`}>
                <Select
                  value={style.messageType}
                  options={PROACTIVE_MESSAGE_TYPES.map(type => ({ value: type, label: t(TYPE_LABELS[type] || 'proactive.type.default') }))}
                  onChange={value => patchSlot(index, {
                    styles: slot.styles.map((item, position) => (
                      position === styleIndex ? { ...item, messageType: value } : item
                    )),
                  })}
                  palette={palette}
                  fonts={fonts}
                />
                <div style={{ width: 84 }}>
                  <TextInput
                    value={String(style.weight)}
                    onChange={value => {
                      const parsed = Number(value);
                      if (!Number.isFinite(parsed) || parsed < 0) return;
                      patchSlot(index, {
                        styles: slot.styles.map((item, position) => (
                          position === styleIndex ? { ...item, weight: parsed } : item
                        )),
                      });
                    }}
                    type="number"
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
              </Row>
            ))}
            {slot.styles.some(item => item.messageType === 'CUSTOM') ? (
              <TextInput
                value={String((slot.styles.find(item => item.messageType === 'CUSTOM') || {}).customPrompt || '')}
                onChange={value => patchSlot(index, {
                  styles: slot.styles.map(item => (
                    item.messageType === 'CUSTOM' ? { ...item, customPrompt: value } : item
                  )),
                })}
                placeholder={t('proactive.customPrompt.placeholder')}
                palette={palette}
                fonts={fonts}
              />
            ) : null}
          </div>

          <Row>
            <Button
              label={t('common.delete')}
              onClick={() => removeSlot(index)}
              palette={palette}
              fonts={fonts}
              tone={palette.danger || '#ff5a5f'}
            />
          </Row>
        </Card>
      ))}
    </div>
  );
}