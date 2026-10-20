// 单聊 / 群聊共用的系统注入计算：时间感知 / 角色作息 / 位置 / 表情包 / 图片下载。
//
// 抽出来的两个理由：① 群聊此前完全没有这些注入，同一角色在群聊与单聊表现不一致；
// ② useChatSend 是行数棘轮文件（只许减不许增），把这块搬出去两条链路共用。
//
// 不 import React，纯异步计算：依赖的存储读函数按两条链路的既有口径直接调用。

import { buildTimeAwareText } from './currentTime.js';
import { buildSchedulePrompt, isScheduleActive } from './schedule.js';
import { resolveStickerNames } from './stickerDirectives.js';
import { getCharacterSchedule } from '../storage/schedule.js';
import { getLocationSettings } from '../storage/location.js';
import { getImageDownloadSources } from '../storage/settings/imageDownloadSources.js';
import { buildLocationText, placeToLocation, resolveActivePlace } from '../location/geo.js';

// 位置注入（双开关门控）：位置分享（enabled）与位置感知（awareness）都开启时给
// 「[当前位置] …」；任一关闭 = 空串——位置感知是独立 opt-in，不给「开地图即默认分享」留后门。
export async function resolveLocationText() {
  try {
    const locationSettings = await getLocationSettings();
    return buildLocationText(
      locationSettings && locationSettings.enabled === true && locationSettings.awareness === true,
      placeToLocation(resolveActivePlace(locationSettings)),
      { maxAgeMs: null }
    );
  } catch (error) {
    return '';
  }
}

// 角色作息：启用时给静态规则文本（含按当前时间判断状态）；未启用/读失败给空串。
export async function resolveScheduleText(characterId, now) {
  try {
    const schedule = characterId ? await getCharacterSchedule(characterId) : null;
    if (!isScheduleActive(schedule)) return { scheduleText: '', scheduleActive: false };
    return {
      scheduleText: buildSchedulePrompt(schedule, { date: now, characterId }),
      scheduleActive: true,
    };
  } catch (error) {
    return { scheduleText: '', scheduleActive: false };
  }
}

// 一次算好两条链路共用的注入参数。
// chatOptions / stickerSource 由调用方传入（避免本模块耦合聊天页的 ref）。
// now 只取一次：时间行与作息规则的工作日/休息日判定必须同一天。
export async function resolveChatInjections({ characterId = '', chatOptions = null, stickerSource = null, now = new Date() } = {}) {
  const [{ scheduleText, scheduleActive }, locationText] = await Promise.all([
    resolveScheduleText(characterId, now),
    resolveLocationText(),
  ]);
  const options = chatOptions || {};
  const timeAware = options.timeAware === true || scheduleActive;
  // 图片下载来源（2026-10-21）：开关开启时读一次（最多 3 张图的场景，开销可接受）。
  // 读失败给空名单 = 不限制（与存储层读侧口径一致）；提示词只在非空时列出名单。
  let downloadImageSources = [];
  if (options.downloadImage === true) {
    try {
      downloadImageSources = await getImageDownloadSources();
    } catch (error) {
      downloadImageSources = [];
    }
  }
  return {
    now,
    scheduleText,
    scheduleActive,
    locationText,
    stickerNames: resolveStickerNames(stickerSource),
    stickerEnabled: options.stickerEnabled === true,
    // 概率档位（2026-10-18）：不再用于 app 侧掷骰，而是喂给提示词的频率措辞。
    // 原样透传（含 undefined），由 buildRequestMessages 归一化——不要在这里提前回落默认值，
    // 否则「用户没设过」和「用户明确设了 50%」会变得不可区分。
    stickerChance: options.stickerChance,
    downloadImageEnabled: options.downloadImage === true,
    downloadImageSources,
    currentTimeText: buildTimeAwareText(timeAware, now),
  };
}
