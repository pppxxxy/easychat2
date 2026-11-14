// 日记（桌面）：每个角色单独开关「自动写日记」，并可为该角色指定写日记用的 API。
//
// 与手机 DiaryPanel 同一套模型与存储：
//   · 设置在 storage/diary.js（getDiarySettings / saveDiarySettings）；
//   · 每角色开关与「用哪个接口」由 diary/diary.js 的 setRoleDiarySetting /
//     resolveRoleDiaryConfigId 处理（纯函数，桌面直接复用）；
//   · 日记正文由 diary/runDiary.js 在跨天启动时生成，本页面只做设置与查看。
//
// 与手机的一处平台差异：手机用左右滑动翻页看日记，桌面用日期列表 + 详情区。
// 开关类控件「改了就落盘」（手机侧踩过的坑：只改内存不写盘 ⇒ 执行器永远筛不到
// 该角色、一篇都不会生成），这里沿用同一条纪律。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { getApiConfigs } from '../../../../src/storage/apiConfigs.js';
import { getDiaries, getDiarySettings, saveDiarySettings } from '../../../../src/storage/diary.js';
import {
  formatDiaryDate,
  getRoleDiarySetting,
  normalizeDiaryEntry,
  resolveRoleDiaryConfigId,
  selectDiariesForCharacter,
  setRoleDiarySetting,
} from '../../../../src/diary/diary.js';
import { Button, Card, Field, Row, Select, Toggle } from '../../settings/ui.jsx';

export default function DiaryScreen({ palette, fonts, onOpenChat = null }) {
  const { t } = useTranslation();
  const { characters, sessions, switchCharacter, switchSession, activeSessionId } = useApp();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [diaries, setDiaries] = useState([]);
  const [roleId, setRoleId] = useState('');
  const [activeDiaryIndex, setActiveDiaryIndex] = useState(0);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // 写盘串行化 + 在途计数：连续快速点击不能互相覆盖，离开前也不静默丢弃。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const writeChainRef = useRef(Promise.resolve());
  const inFlightRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getDiarySettings(),
      getApiConfigs().catch(() => ({ configs: [] })),
      getDiaries().catch(() => []),
    ])
      .then(([stored, api, list]) => {
        if (cancelled) return;
        setSettings(stored);
        setConfigs(Array.isArray(api.configs) ? api.configs : []);
        setDiaries(list);
      })
      .catch(() => {
        if (!cancelled) setNotice(t('diary.notice.loadFailed'));
      })
      .then(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [t]);

  // 默认选中当前第一个角色；角色列表变化时纠正失效选择。
  useEffect(() => {
    const ids = (Array.isArray(characters) ? characters : []).map(item => String((item && item.id) || '')).filter(Boolean);
    setRoleId(current => (current && ids.includes(current) ? current : (ids[0] || '')));
  }, [characters]);

  // 换角色时回到该角色最近一篇日记。
  useEffect(() => {
    setActiveDiaryIndex(0);
  }, [roleId]);

  const roleNameText = String(
    ((Array.isArray(characters) ? characters : []).find(item => item && item.id === roleId) || {}).name
    || ''
  ).trim() || t('diary.roleFallback');
  const roleDiaries = selectDiariesForCharacter(diaries, roleId).slice().reverse();
  const roleSetting = settings ? getRoleDiarySetting(settings, roleId) : { enabled: false, apiConfigId: '', model: '' };
  const activeDiary = roleDiaries[activeDiaryIndex] || null;
  const activeEntry = activeDiary ? normalizeDiaryEntry(activeDiary) : null;

  // 日记的来源会话（手机 DiaryPanel 的 diarySource 同一判据）：
  // sourceSessionIds 优先，旧条目只有 sessionId。找不到会话就不显示链接。
  const sessionMap = new Map(
    (Array.isArray(sessions) ? sessions : []).map(item => [String(item.id), item])
  );
  const diarySource = (() => {
    if (!activeEntry) return null;
    const ids = Array.isArray(activeEntry.sourceSessionIds) && activeEntry.sourceSessionIds.length
      ? activeEntry.sourceSessionIds
      : (activeEntry.sessionId ? [activeEntry.sessionId] : []);
    if (ids.length === 0) return null;
    const primaryId = String(activeEntry.sessionId || '').trim() || ids[0];
    const primary = sessionMap.get(primaryId);
    if (!primary) return { id: primaryId, label: t('diary.source.deleted'), openable: false };
    const name = String(primary.name || '').trim()
      || (primary.type === 'group'
        ? t('diary.source.groupFallback')
        : (activeEntry.characterName || t('diary.roleFallback')));
    return {
      id: primaryId,
      label: ids.length > 1
        ? t('diary.source.multi', { name, count: ids.length })
        : t('diary.source.single', { name }),
      openable: true,
    };
  })();

  // 跳到来源会话：失败回滚到原会话（与记忆页打开会话的既有模式一致）。
  const openDiarySource = async () => {
    if (!diarySource || !diarySource.openable) return;
    const target = sessionMap.get(diarySource.id);
    if (!target) return;
    const previousSessionId = activeSessionId;
    try {
      if (target.type !== 'group' && target.characterId) {
        await switchCharacter(target.characterId);
      }
      await switchSession(target.id);
      if (typeof onOpenChat === 'function') onOpenChat(target.id);
    } catch (error) {
      try {
        if (previousSessionId) await switchSession(previousSessionId);
      } catch (rollbackError) {}
      setNotice(t('diary.source.jumpFailed'));
    }
  };

  // 改了就落盘：纯函数算出新设置，再串行写盘。失败保留旧状态并告知。
  const commit = useCallback(async updater => {
    const base = settingsRef.current;
    if (!base) return;
    const next = updater(base);
    setSettings(next);
    settingsRef.current = next;
    inFlightRef.current += 1;
    setSaving(true);
    const task = writeChainRef.current
      .catch(() => {})
      .then(() => saveDiarySettings(next))
      .then(saved => {
        // 写盘后以存储层归一化的结果为准（它可能补默认值）。
        setSettings(saved);
        settingsRef.current = saved;
      })
      .catch(() => {
        setNotice(t('diary.notice.saveFailed'));
      })
      .then(() => {
        inFlightRef.current -= 1;
        if (inFlightRef.current <= 0) setSaving(false);
      });
    writeChainRef.current = task;
  }, [t]);

  const toggleRoleEnabled = enabled => {
    if (!roleId) return;
    const name = (Array.isArray(characters) ? characters : [])
      .find(item => item && item.id === roleId);
    void commit(current => setRoleDiarySetting(current, roleId, {
      enabled,
      roleName: String((name && name.name) || ''),
    }));
  };

  const patchRoleConfig = (field, value) => {
    if (!roleId) return;
    void commit(current => setRoleDiarySetting(current, roleId, { [field]: value }));
  };

  const roleOptions = (Array.isArray(characters) ? characters : []).map(item => ({
    value: item.id,
    label: item.name || t('common.unnamedCharacter'),
  }));

  const configOptions = [
    { value: '', label: t('diary.apiDefault') },
    ...configs.map(item => ({ value: item.id, label: item.name || t('settings.api.unnamed') })),
  ];

  const resolvedConfigId = settings ? resolveRoleDiaryConfigId(settings, roleId) : '';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('diary.title')} hint={t('diary.intro')} palette={palette} fonts={fonts}>
        {loading ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : (
          <>
            <Field label={t('diary.roleLabel')} palette={palette} fonts={fonts}>
              <Select
                value={roleId}
                options={roleOptions}
                onChange={setRoleId}
                palette={palette}
                fonts={fonts}
                disabled={roleOptions.length === 0}
              />
            </Field>
            {roleOptions.length === 0 ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('diary.empty.description')}</div>
            ) : null}

            <Toggle
              checked={roleSetting.enabled === true}
              onChange={toggleRoleEnabled}
              label={t('diary.enableFor', { name: roleNameText })}
              palette={palette}
              fonts={fonts}
              disabled={saving && inFlightRef.current > 0}
            />
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
              {t('diary.enableHint')}
            </div>

            {roleSetting.enabled ? (
              <>
                <Field label={t('diary.apiLabel', { name: roleNameText })} hint={t('diary.apiEmpty')} palette={palette} fonts={fonts}>
                  <Select
                    value={roleSetting.apiConfigId || ''}
                    options={configOptions}
                    onChange={value => patchRoleConfig('apiConfigId', value)}
                    palette={palette}
                    fonts={fonts}
                  />
                </Field>
                <Field label={t('diary.apiLabel', { name: roleNameText })} hint={t('diary.apiEmpty')} palette={palette} fonts={fonts}>
                  <Select
                    value={roleSetting.model || ''}
                    options={[
                      { value: '', label: t('diary.apiDefaultShort') },
                      ...((configs.find(item => item.id === resolvedConfigId) || {}).models || [])
                        .map(model => ({ value: model, label: model })),
                    ]}
                    onChange={value => patchRoleConfig('model', value)}
                    palette={palette}
                    fonts={fonts}
                  />
                </Field>
              </>
            ) : null}
            {notice ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{notice}</div>
            ) : null}
          </>
        )}
      </Card>

      <Card
        title={t('diary.sectionTitle', { name: roleNameText })}
        hint={t('diary.enableHint')}
        palette={palette}
        fonts={fonts}
      >
        {roleDiaries.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('diary.empty')}</div>
        ) : (
          <div style={{ display: 'flex', gap: 12, minHeight: 0 }}>
            <div style={{ width: 172, flex: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {roleDiaries.map((item, index) => {
                const entry = normalizeDiaryEntry(item);
                const active = index === activeDiaryIndex;
                return (
                  <button
                    key={entry.date || `diary-${index}`}
                    type="button"
                    onClick={() => setActiveDiaryIndex(index)}
                    style={{
                      textAlign: 'left',
                      background: active ? palette.surfaceAlt : 'transparent',
                      color: palette.text,
                      border: `1px solid ${active ? palette.primaryMuted : palette.divider}`,
                      borderRadius: 8,
                      padding: '6px 9px',
                      fontSize: fonts.scaled(12),
                      cursor: 'pointer',
                    }}
                  >
                    {formatDiaryDate(entry.date) || t('diary.unnamed')}
                  </button>
                );
              })}
            </div>
            <div style={{
              flex: 1,
              minWidth: 0,
              maxHeight: '46vh',
              overflow: 'auto',
              background: palette.surfaceAlt,
              border: `1px solid ${palette.divider}`,
              borderRadius: 10,
              padding: '10px 12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: fonts.scaled(13),
              lineHeight: 1.75,
              color: palette.text,
            }}
            >
              {activeEntry && activeEntry.text
                ? activeEntry.text
                : t('diary.empty')}
            </div>
          </div>
        )}

        {/* 来源会话：可点进那一段对话（手机 DiaryPanel 的「来自对话」）。 */}
        {diarySource ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={openDiarySource}
              disabled={!diarySource.openable}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: diarySource.openable
                  ? (palette.primaryMuted || palette.primary)
                  : palette.textFaint,
                cursor: diarySource.openable ? 'pointer' : 'default',
                fontSize: fonts.scaled(11),
                textDecoration: diarySource.openable ? 'underline' : 'none',
              }}
            >
              {diarySource.label}
            </button>
          </div>
        ) : null}

        {/* 上次运行统计：可观测性入口（手机 diary.lastRun）。失败/跳过数为 0 时仍显示，
            方便一眼确认「今天到底跑没跑」。 */}
        {settings && settings.lastRun ? (
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('diary.lastRun', {
              date: settings.lastRun.date || '',
              written: Number(settings.lastRun.written) || 0,
              skipped: Number(settings.lastRun.skipped) || 0,
              failed: Number(settings.lastRun.failed) || 0,
            })}
          </div>
        ) : null}
        <Row>
          <Button
            label={t('diary.prevDay')}
            onClick={() => setActiveDiaryIndex(index => Math.min(index + 1, Math.max(0, roleDiaries.length - 1)))}
            palette={palette}
            fonts={fonts}
            disabled={roleDiaries.length === 0 || activeDiaryIndex >= roleDiaries.length - 1}
          />
          <Button
            label={t('diary.nextDay')}
            onClick={() => setActiveDiaryIndex(index => Math.max(0, index - 1))}
            palette={palette}
            fonts={fonts}
            disabled={activeDiaryIndex <= 0}
          />
        </Row>
      </Card>
    </div>
  );
}