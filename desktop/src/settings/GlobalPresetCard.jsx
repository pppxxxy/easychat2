// 全局文本预设（桌面）：一组无视角色卡、对所有对话生效的提示词片段。
//
// 与手机 PresetPanel 的「全局」部分同源：
//   · 列表与归一化：storage/globalPresets.js 的 getGlobalPresets（含损坏回退到内置集）；
//   · 开关：getGlobalPresetSettings / saveGlobalPresetSettings（整键覆盖，但有
//     「读坏拒绝写」守卫——读失败时把开关写回会把所有预设写成全关）；
//   · 条目编辑：新增/修改都走 saveGlobalPresets + createGlobalPresetId，删除走
//     「重读 → 过滤 → 写回」（与手机同一顺序，避免用界面里的旧列表覆盖别人的改动）；
//   · 真正生效的路径在共享层：useChatSend 每轮请求前读 getEnabledGlobalPresetPrompts，
//     把它们追加进系统提示词。桌面只要写同一份存储，行为就与手机一致。
//
// 字段口径照抄共享层 normalizePreset：name 与 prompt 必填（空白会被拒绝），description 可选。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  createGlobalPresetId,
  getGlobalPresetSettings,
  getGlobalPresets,
  saveGlobalPresetSettings,
  saveGlobalPresets,
} from '../../../src/storage/globalPresets.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, TextInput, Toggle } from './ui.jsx';

const EMPTY_FORM = { name: '', description: '', prompt: '' };

export default function GlobalPresetCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState([]);
  const [enabled, setEnabled] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // null = 表单关闭；{ id } = 编辑已有条目（id 为空串表示新增）。
  const [form, setForm] = useState(null);
  const [draft, setDraft] = useState(EMPTY_FORM);
  const enabledRef = useRef({});
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, map] = await Promise.all([getGlobalPresets(), getGlobalPresetSettings()]);
      setPresets(list);
      setEnabled(map || {});
      enabledRef.current = map || {};
    } catch (error) {
      Alert.alert(t('preset.alert.loadFailed.title'), t('preset.alert.loadFailed.body'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // 改了就落盘（与手机同一条纪律：只改内存不写盘，用户以为开了但模型收不到）。
  const toggle = async (id, value) => {
    if (busyRef.current) return;
    const next = { ...enabledRef.current, [id]: value };
    setEnabled(next);
    enabledRef.current = next;
    busyRef.current = true;
    setSaving(true);
    try {
      const saved = await saveGlobalPresetSettings(next);
      setEnabled(saved);
      enabledRef.current = saved;
    } catch (error) {
      // 读坏守卫会抛错：把界面回滚到落盘值，绝不显示「已开启」却没写进去。
      await load();
      Alert.alert(t('preset.alert.saveFailed.title'), t('preset.alert.saveFailed.body'));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const openCreate = () => {
    setForm({ id: '' });
    setDraft(EMPTY_FORM);
  };

  const openEdit = preset => {
    setForm({ id: preset.id });
    setDraft({
      name: String(preset.name || ''),
      description: String(preset.description || ''),
      prompt: String(preset.prompt || ''),
    });
  };

  // 保存：名称与提示词必填（共享层 normalizePreset 会拒绝空白，这里提前拦住并给明确提示）。
  const saveForm = async () => {
    if (!form || busyRef.current) return;
    const name = String(draft.name || '').trim();
    const prompt = String(draft.prompt || '').trim();
    if (!name || !prompt) {
      Alert.alert(t('preset.alert.infoIncomplete.title'), t('preset.alert.infoIncomplete.body'));
      return;
    }
    busyRef.current = true;
    setSaving(true);
    try {
      // 每次都先重读：界面里的 presets 可能是别处（如手机端同步、另一窗口）改过之前的快照，
      // 直接用它拼列表会覆盖别人的改动。手机侧同样是 `await getGlobalPresets()` 再写。
      const base = await getGlobalPresets();
      const id = form.id || await createGlobalPresetId(base);
      const item = {
        id,
        name,
        description: String(draft.description || '').trim(),
        prompt,
      };
      const list = form.id
        ? base.map(entry => (entry.id === id ? item : entry))
        : [...base, item];
      const saved = await saveGlobalPresets(list);
      setPresets(saved);
      setForm(null);
      setDraft(EMPTY_FORM);
      // 新增的条目默认是关闭态；normalizeEnabledMap 会把它补成 false，这里同步一下界面。
      const map = await getGlobalPresetSettings();
      setEnabled(map || {});
      enabledRef.current = map || {};
    } catch (error) {
      Alert.alert(
        t('preset.alert.saveFailed.title'),
        String((error && error.message) || t('preset.alert.saveFailed.body'))
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const deletePreset = preset => {
    if (!preset || busyRef.current) return;
    Alert.alert(
      t('preset.alert.delete.title'),
      t('preset.alert.delete.body', { name: preset.name || t('preset.unnamed') }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setSaving(true);
            try {
              // 与手机同顺序：重读当前列表 → 过滤 → 写回（不用界面快照）。
              const saved = await saveGlobalPresets(
                (await getGlobalPresets()).filter(item => item.id !== preset.id)
              );
              setPresets(saved);
              setEnabled(current => {
                const next = { ...current };
                delete next[preset.id];
                enabledRef.current = next;
                return next;
              });
              // 开关表也存在盘上，删条目后要同步落盘（否则残留一条指向不存在预设的开关）。
              await saveGlobalPresetSettings(enabledRef.current).catch(() => {});
            } catch (error) {
              Alert.alert(
                t('preset.alert.deleteFailed.title'),
                String((error && error.message) || t('preset.alert.saveFailed.body'))
              );
            } finally {
              busyRef.current = false;
              setSaving(false);
            }
          },
        },
      ]
    );
  };

  return (
    <Card title={t('preset.title.global')} hint={t('preset.hint.global')} palette={palette} fonts={fonts}>
      {loading ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          {presets.length === 0 ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('preset.empty')}</div>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {presets.map(preset => (
              <div
                key={preset.id}
                style={{
                  border: `1px solid ${palette.divider}`,
                  borderRadius: 8,
                  padding: '7px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <Toggle
                  checked={enabled[preset.id] === true}
                  onChange={value => toggle(preset.id, value)}
                  label={preset.name || t('preset.unnamed')}
                  palette={palette}
                  fonts={fonts}
                  disabled={saving}
                />
                <div style={{
                  fontSize: fonts.scaled(10),
                  color: palette.textFaint,
                  lineHeight: 1.6,
                  maxHeight: 54,
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                }}
                >
                  {String(preset.prompt || '').slice(0, 200)}
                </div>
                <Row>
                  <Button
                    label={t('preset.editor.editTitle')}
                    onClick={() => openEdit(preset)}
                    palette={palette}
                    fonts={fonts}
                    disabled={saving}
                  />
                  <Button
                    label={t('preset.a11y.delete')}
                    onClick={() => deletePreset(preset)}
                    palette={palette}
                    fonts={fonts}
                    tone={palette.danger || '#ff5a5f'}
                    disabled={saving}
                  />
                </Row>
              </div>
            ))}
          </div>

          {form ? (
            <div style={{
              border: `1px solid ${palette.primaryMuted}`,
              borderRadius: 10,
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
            >
              <strong style={{ fontSize: fonts.scaled(13) }}>
                {form.id ? t('preset.editor.editTitle') : t('preset.add')}
              </strong>
              <Field label={t('preset.editor.nameLabel')} palette={palette} fonts={fonts}>
                <TextInput
                  value={draft.name}
                  onChange={value => setDraft(current => ({ ...current, name: value }))}
                  placeholder={t('preset.editor.namePlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </Field>
              <Field label={t('preset.editor.namePlaceholder')} palette={palette} fonts={fonts}>
                <TextInput
                  value={draft.description}
                  onChange={value => setDraft(current => ({ ...current, description: value }))}
                  placeholder={t('preset.editor.descPlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </Field>
              <Field label={t('preset.editor.promptLabel')} palette={palette} fonts={fonts}>
                <textarea
                  value={draft.prompt}
                  onChange={event => setDraft(current => ({ ...current, prompt: event.target.value }))}
                  placeholder={t('preset.editor.promptPlaceholder')}
                  rows={5}
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
              </Field>
              <Row>
                <Button
                  label={saving ? t('preset.alert.busy.title') : t('common.save')}
                  onClick={saveForm}
                  palette={palette}
                  fonts={fonts}
                  primary
                  disabled={saving}
                />
                <Button
                  label={t('common.cancel')}
                  onClick={() => { setForm(null); setDraft(EMPTY_FORM); }}
                  palette={palette}
                  fonts={fonts}
                  disabled={saving}
                />
              </Row>
            </div>
          ) : (
            <Row>
              <Button label={t('preset.add')} onClick={openCreate} palette={palette} fonts={fonts} disabled={saving} primary />
            </Row>
          )}
        </>
      )}
    </Card>
  );
}