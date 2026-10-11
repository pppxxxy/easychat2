// 作息面板的**用户可见**摘要文本（i18n）。
//
// 与 src/chat/schedule.js 的 describeSchedule 分开：后者是发给模型的规则文本（中文、
// 按仓库铁律不进 i18n），这里是界面上的预览，必须走 t()。
// 纯函数（t 由调用方传入），可在 Node 直测。

import { resolveScheduleSegment } from '../../chat/schedule.js';

const EMPTY_DAY = { segments: [], events: [] };

function dayOf(schedule, kind) {
  const day = schedule && schedule[kind];
  return day && typeof day === 'object' ? day : EMPTY_DAY;
}

// 时间段显示名：用户填的名称优先；迁移出来的内置段回退词条（睡眠/工作）。
export function segmentLabelText(segment, t) {
  if (!segment) return '';
  if (segment.name) return segment.name;
  if (segment.builtin) return t(`schedule.builtin.${segment.builtin}`);
  return t('schedule.segmentFallback');
}

export function segmentsText(segments, t) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) return t('schedule.preview.none');
  return list.map(segment => `${segmentLabelText(segment, t)} ${segment.start}–${segment.end}`).join('、');
}

export function eventWhenText(event) {
  return event && event.kind === 'range' ? `${event.start}–${event.end}` : String((event && event.at) || '');
}

export function eventsText(events, t) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return t('schedule.preview.none');
  return list.map(event => `${eventWhenText(event)} ${event.description}（${event.probability}%）`).join('、');
}

// 预览多行：工作日一套（未开启分套时就是唯一一套）+ 休息日一套 + 概率事件 + 假日数。
export function schedulePreviewLines(schedule, t) {
  const work = dayOf(schedule, 'workday');
  const rest = dayOf(schedule, 'restday');
  const split = schedule && schedule.splitWeekday === true;
  const holidays = schedule && Array.isArray(schedule.holidays) ? schedule.holidays : [];
  const lines = [`${t('schedule.preview.workday')}：${segmentsText(work.segments, t)}`];
  if (split) {
    lines.push(`${t('schedule.preview.restday')}：${segmentsText(rest.segments, t)}`);
    if (work.events.length > 0) {
      lines.push(`${t('schedule.preview.events')}（${t('schedule.preview.workday')}）：${eventsText(work.events, t)}`);
    }
    if (rest.events.length > 0) {
      lines.push(`${t('schedule.preview.events')}（${t('schedule.preview.restday')}）：${eventsText(rest.events, t)}`);
    }
    if (holidays.length > 0) lines.push(t('schedule.preview.holidays', { count: holidays.length }));
  } else if (work.events.length > 0) {
    lines.push(`${t('schedule.preview.events')}：${eventsText(work.events, t)}`);
  }
  return lines;
}

// 当前处于哪个时间段（没命中就是空闲）。
export function currentPeriodText(schedule, t, date = new Date()) {
  const segment = resolveScheduleSegment(schedule, date);
  return segment ? segmentLabelText(segment, t) : t('schedule.period.free');
}
