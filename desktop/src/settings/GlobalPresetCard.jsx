// 全局文本预设（桌面）：一组无视角色卡、对所有对话生效的提示词片段。
//
// 与手机 PresetPanel 的「全局」部分同源：
//   · 列表与归一化：storage/globalPresets.js 的 getGlobalPresets（含损坏回退到内置集）；
//   · 开关：getGlobalPresetSettings / saveGlobalPresetSettings（整键覆盖，但有
//     「读坏拒绝写」守卫——读失败时把开关写回会把所有预设写成全关）；
//   · 真正生效的路径在共享层：useChatSend 每轮请求前读 getEnabledGlobalPresetPrompts，
//     把它们追加进系统提示词。桌面只要把开关接上，行为与手机一致。
//
// 手机还提供「新增/编辑/删除」预设条目。桌面这版只做开关（这是**最常用**的操作）：
// 编辑预设是一套多字段表单，属于独立工作量；界面已提供「在手机上编辑」的如实说明，
// 不假装支持。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  getGlobalPresetSettings,
  getGlobalPresets,
  saveGlobalPresetSettings,
} from '../../../src/storage/globalPresets.js';
import { Alert } from '../platform/alert.js';
import { Card, Toggle } from './ui.jsx';

export default function GlobalPresetCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState([]);
  const [enabled, setEnabled] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const enabledRef = useRef({});

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
    if (saving) return;
    const next = { ...enabledRef.current, [id]: value };
    setEnabled(next);
    enabledRef.current = next;
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
      setSaving(false);
    }
  };

  return (
    <Card title={t('preset.title.global')} hint={t('preset.hint.global')} palette={palette} fonts={fonts}>
      {loading ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          {presets.length === 0 ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('preset.unnamed')}</div>
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
              </div>
            ))}
          </div>
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('desktop.presets.editOnMobile')}
          </div>
        </>
      )}
    </Card>
  );
}