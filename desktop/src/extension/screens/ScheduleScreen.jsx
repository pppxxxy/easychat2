// 角色作息（桌面）：与手机 extension/SchedulePanel 同一套模型与判定。
//
// 模型（src/chat/schedule.js 的 v2 schema）：
//   · 时间段可增删改，名称任意，支持跨零点；列表顺序 = 命中优先级；
//   · 概率事件（时间点或时间段 + 概率 + 「要做的事」）；
//   · 「区分工作日/休息日」两套作息 + 用户可编辑的节假日列表。
//
// 桌面只需 DOM 界面：normalizeSchedule / draftOps 的不可变更新 / preview 的文案
// 全部复用共享层，一行判定都不重写。作息本身只写进提示词，不新增原生能力——
// 手机端的 runSchedule 提示词注入走的是共享 chat/chatInjections。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { createDefaultSchedule, normalizeSchedule } from '../../../../src/chat/schedule.js';
import { getCharacterSchedule, saveCharacterSchedule } from '../../../../src/storage/schedule.js';
import {
  addEvent,
  addHoliday,
  addSegment,
  moveSegment,
  removeEvent,
  removeHoliday,
  removeSegment,
  setEnabled,
  setSplitWeekday,
  updateEvent,
  updateSegment,
} from '../../../../src/extension/schedule/draftOps.js';
import { currentPeriodText, schedulePreviewLines } from '../../../../src/extension/schedule/preview.js';
import { Button, Card, Field, Row, Select, TextInput, Toggle } from '../../settings/ui.jsx';

const DAY_TABS = ['workday', 'restday'];

export default function ScheduleScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters, activeId } = useApp();
  const [roleId, setRoleId] = useState('');
  const [draft, setDraft] = useState(createDefaultSchedule);
  const [dayKind, setDayKind] = useState('workday');
  const [holidayDraft, setHolidayDraft] = useState('');
  const [holidayInvalid, setHolidayInvalid] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // 默认选中当前活跃角色；角色列表变化时纠正失效选择（与手机同一口径）。
  useEffect(() => {
    const ids = (Array.isArray(characters) ? characters : []).map(item => String((item && item.id) || ''));
    if (ids.length === 0) {
      setRoleId('');
      return;
    }
    setRoleId(current => (
      current && ids.includes(current)
        ? current
        : (ids.includes(String(activeId)) ? String(activeId) : ids[0])
    ));
  }, [characters, activeId]);

  // 切换角色时读取其作息（无则默认值；旧四时刻数据由 normalizeSchedule 迁移）。
  useEffect(() => {
    let cancelled = false;
    if (!roleId) return undefined;
    setDayKind('workday');
    setHolidayDraft('');
    setHolidayInvalid(false);
    setNotice('');
    getCharacterSchedule(roleId)
      .then(schedule => {
        if (cancelled) return;
        setDraft(schedule ? normalizeSchedule(schedule) : createDefaultSchedule());
      })
      .catch(() => {
        if (!cancelled) setDraft(createDefaultSchedule());
      });
    return () => { cancelled = true; };
  }, [roleId]);

  // 所有草稿改动都走 draftOps 的纯函数（不可变更新），并清掉上一次的提示。
  const apply = useCallback(updater => {
    setDraft(current => updater(current));
    setNotice('');
  }, []);

  const day = dayKind === 'restday' ? draft.restday : draft.workday;
  const segments = (day && Array.isArray(day.segments)) ? day.segments : [];
  const events = (day && Array.isArray(day.events)) ? day.events : [];

  const previewLines = useMemo(() => schedulePreviewLines(draft, t), [draft, t]);
  const nowText = useMemo(() => currentPeriodText(draft, t), [draft, t]);

  const save = async () => {
    if (!roleId || saving) return;
    setSaving(true);
    try {
      const normalized = normalizeSchedule(draft);
      await saveCharacterSchedule(roleId, normalized);
      setDraft(normalized);
      setNotice(t('schedule.saved'));
    } catch (error) {
      setNotice(t('schedule.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const addHolidayKey = () => {
    const next = addHoliday(draft, holidayDraft);
    if (next === draft) {
      // 纯函数在日期非法时原样返回：界面据此给出明确提示，而不是静默无事发生。
      setHolidayInvalid(true);
      return;
    }
    setHolidayInvalid(false);
    setHolidayDraft('');
    setDraft(next);
    setNotice('');
  };

  const roleOptions = (Array.isArray(characters) ? characters : []).map(item => ({
    value: item.id,
    label: item.name || t('common.unnamedCharacter'),
  }));

  const smallInput = { width: 96 };
  const numberInput = { width: 72 };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.home.schedule')} hint={t('ext.home.schedule.desc')} palette={palette} fonts={fonts}>
        <Field label={t('schedule.selectRole')} palette={palette} fonts={fonts}>
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
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.noRoles')}</div>
        ) : null}
        <Toggle
          checked={draft.enabled}
          onChange={value => apply(current => setEnabled(current, value))}
          label={t('schedule.enable')}
          palette={palette}
          fonts={fonts}
        />
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('schedule.enableHint')}</div>
        <Toggle
          checked={draft.splitWeekday}
          onChange={value => apply(current => setSplitWeekday(current, value))}
          label={t('schedule.splitWeekday')}
          palette={palette}
          fonts={fonts}
        />
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('schedule.splitWeekdayHint')}</div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {draft.enabled ? t('schedule.hint') : t('schedule.disabledHint')}
        </div>

        <Row>
          <Button
            label={saving ? t('backup.progress.ratio') : t('schedule.save')}
            onClick={save}
            palette={palette}
            fonts={fonts}
            primary
            disabled={saving || !roleId}
          />
          <Button
            label={saving ? t('backup.progress.ratio') : t('schedule.save')}
            onClick={save}
            palette={palette}
            fonts={fonts}
            primary
            disabled={saving || !roleId}
          />
        </Row>
        {notice ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{notice}</div>
        ) : null}
        {nowText ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.primaryMuted || palette.primary }}>
            {nowText}
          </div>
        ) : null}

        {previewLines.length > 0 ? (
          <div style={{
            background: palette.surfaceAlt,
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: fonts.scaled(11),
            color: palette.textMuted,
            lineHeight: 1.7,
          }}
          >
            {previewLines.map((line, index) => (
              <div key={`preview-${index}`}>{line}</div>
            ))}
          </div>
        ) : null}

        {/* 工作日 / 休息日两套（未开启区分时只有 workday 一套，标签隐藏） */}
        {draft.splitWeekday ? (
          <Row>
            {DAY_TABS.map(kind => (
              <Button
                key={kind}
                label={t(`schedule.dayKind.${kind}`)}
                onClick={() => setDayKind(kind)}
                palette={palette}
                fonts={fonts}
                primary={dayKind === kind}
              />
            ))}
          </Row>
        ) : null}
      </Card>

      <Card title={t('schedule.segments.title')} hint={t('schedule.segments.orderHint')} palette={palette} fonts={fonts}>
        {segments.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.segments.empty')}</div>
        ) : null}
        {segments.map((segment, index) => (
          <div
            key={segment.id || `segment-${index}`}
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
                  value={segment.name || ''}
                  onChange={value => apply(current => updateSegment(current, dayKind, index, { name: value }))}
                  placeholder={t('schedule.segments.namePlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <div style={smallInput}>
                <TextInput
                  value={segment.start || ''}
                  onChange={value => apply(current => updateSegment(current, dayKind, index, { start: value }))}
                  placeholder="09:00"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <div style={smallInput}>
                <TextInput
                  value={segment.end || ''}
                  onChange={value => apply(current => updateSegment(current, dayKind, index, { end: value }))}
                  placeholder="12:00"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Button label="↑" onClick={() => apply(current => moveSegment(current, dayKind, index, -1))} palette={palette} fonts={fonts} disabled={index === 0} />
              <Button label="↓" onClick={() => apply(current => moveSegment(current, dayKind, index, 1))} palette={palette} fonts={fonts} disabled={index === segments.length - 1} />
              <Button label={t('common.delete')} onClick={() => apply(current => removeSegment(current, dayKind, index))} palette={palette} fonts={fonts} tone={palette.danger || '#ff5a5f'} />
            </Row>
          </div>
        ))}
        <Row>
          <Button label={t('schedule.segments.add')} onClick={() => apply(current => addSegment(current, dayKind))} palette={palette} fonts={fonts} />
          <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('schedule.segments.orderHint')}</span>
        </Row>
      </Card>

      <Card title={t('schedule.events.title')} hint={t('schedule.events.hint')} palette={palette} fonts={fonts}>
        {events.length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.events.empty')}</div>
        ) : null}
        {events.map((event, index) => (
          <div
            key={event.id || `event-${index}`}
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
              <Select
                value={event.kind === 'range' ? 'range' : 'point'}
                options={[
                  { value: 'point', label: t('schedule.events.kind.point') },
                  { value: 'range', label: t('schedule.events.kind.range') },
                ]}
                onChange={value => apply(current => updateEvent(current, dayKind, index, { kind: value }))}
                palette={palette}
                fonts={fonts}
              />
              <div style={smallInput}>
                <TextInput
                  value={event.at || ''}
                  onChange={value => apply(current => updateEvent(current, dayKind, index, { at: value }))}
                  placeholder="15:00"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              {event.kind === 'range' ? (
                <div style={smallInput}>
                  <TextInput
                    value={event.end || ''}
                    onChange={value => apply(current => updateEvent(current, dayKind, index, { end: value }))}
                    placeholder="17:00"
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
              ) : null}
              <div style={numberInput}>
                <TextInput
                  value={String(event.probability ?? '')}
                  onChange={value => {
                    const parsed = Math.trunc(Number(value));
                    if (!Number.isFinite(parsed)) return;
                    apply(current => updateEvent(current, dayKind, index, { probability: parsed }));
                  }}
                  type="number"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Button label={t('common.delete')} onClick={() => apply(current => removeEvent(current, dayKind, index))} palette={palette} fonts={fonts} tone={palette.danger || '#ff5a5f'} />
            </Row>
            <TextInput
              value={event.description || ''}
              onChange={value => apply(current => updateEvent(current, dayKind, index, { description: value }))}
              placeholder={t('schedule.events.descriptionPlaceholder')}
              palette={palette}
              fonts={fonts}
            />
          </div>
        ))}
        <Row>
          <Button label={t('schedule.events.add')} onClick={() => apply(current => addEvent(current, dayKind))} palette={palette} fonts={fonts} />
        </Row>
      </Card>

      <Card title={t('schedule.holidays.title')} hint={t('schedule.holidays.hint')} palette={palette} fonts={fonts}>
        <Row>
          <div style={{ ...smallInput, width: 140 }}>
            <TextInput
              value={holidayDraft}
              onChange={value => { setHolidayDraft(value); setHolidayInvalid(false); }}
              placeholder="2026-01-01"
              palette={palette}
              fonts={fonts}
            />
          </div>
          <Button label={t('schedule.holidays.add')} onClick={addHolidayKey} palette={palette} fonts={fonts} />
          {holidayInvalid ? (
            <span style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
              {t('schedule.holidays.invalid')}
            </span>
          ) : null}
        </Row>
        {(Array.isArray(draft.holidays) ? draft.holidays : []).length === 0 ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('schedule.holidays.empty')}</div>
        ) : null}
        <Row>
          {(Array.isArray(draft.holidays) ? draft.holidays : []).map(keyValue => (
            <Button
              key={keyValue}
              label={`${keyValue} ×`}
              onClick={() => apply(current => removeHoliday(current, keyValue))}
              palette={palette}
              fonts={fonts}
            />
          ))}
        </Row>
      </Card>
    </div>
  );
}