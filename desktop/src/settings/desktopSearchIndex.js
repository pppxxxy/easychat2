// 桌面设置搜索索引：在共享索引之上做**分区映射**，并补上桌面独有的分区。
//
// 为什么不直接用共享的 searchSettings：
//   共享索引是按**手机的分区 id** 写的（settings/sectionOrder.js 的 15 个 id）。桌面的
//   分区是它的一个子集加几个自己的（见 desktop SettingsScreen 的 SECTIONS）。直接套用
//   会有两类错误：
//     · 手机有、桌面没有的分区（workspace / github / mcpservers / localmodel）→ 搜出来
//       点进去无处可去，是「死结果」；
//     · 手机把「功能扩展」放在 extensions 一张卡里，桌面拆进了 experience（对话体验）；
//       「界面语言」手机是独立分区，桌面在外观卡里。不映射就会跳到错误的分区。
//   所以这里显式写两张表：DROP（丢弃）与 REMAP（改归属）。新增分区时两张表都要过一遍。
//
// 桌面独有的分区（presets / location / ocr / diagnostics）在共享索引里没有条目，
// 这里补最小可用集：只要用户能搜到并跳到那张卡，条目粒度不必和手机一致。
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  settingsSectionLabel,
} from '../../../src/settings/searchIndex.js';

// 手机有、桌面没有的分区：整段丢弃（不是隐藏，是不参与搜索）。
export const DESKTOP_DROPPED_SECTIONS = Object.freeze([
  'workspace',
  'github',
  'mcpservers',
  'localmodel',
]);

// 手机分区 → 桌面分区的改归属。
export const DESKTOP_SECTION_REMAP = Object.freeze({
  // 手机「功能扩展」卡（自动配图/联网/播报/转写）在桌面并入「对话体验」。
  extensions: 'experience',
  // 手机「界面语言」是独立分区，桌面在外观卡里。
  language: 'appearance',
});

// 桌面独有分区的补充条目。labelKey 复用各卡自己的标题键，措辞不可能与卡漂移。
export const DESKTOP_ONLY_ENTRIES = Object.freeze([
  { sectionId: 'presets', labelKey: 'preset.title.global', keywords: ['预设', 'preset', '全局', '提示词片段'] },
  { sectionId: 'location', labelKey: 'world.map.real.places.title', keywords: ['位置', '地点', 'location', '经纬度', '坐标'] },
  { sectionId: 'ocr', labelKey: 'settings.imageRecognition.sectionTitle', keywords: ['识图', 'ocr', '图片识别', '视觉'] },
  { sectionId: 'diagnostics', labelKey: 'diagnostics.title', keywords: ['诊断', '日志', 'diagnostics', '排障', '复制'] },
]);

// 由共享索引算出桌面索引：丢弃 → 改归属 → 合并桌面独有。
export function buildDesktopSearchIndex({
  shared = SETTINGS_SEARCH_INDEX,
  dropped = DESKTOP_DROPPED_SECTIONS,
  remap = DESKTOP_SECTION_REMAP,
  extra = DESKTOP_ONLY_ENTRIES,
} = {}) {
  const drop = new Set(dropped);
  const mapped = (Array.isArray(shared) ? shared : [])
    .filter(item => item && typeof item === 'object' && !drop.has(item.sectionId))
    .map(item => (
      remap[item.sectionId] ? { ...item, sectionId: remap[item.sectionId] } : item
    ));
  return [...mapped, ...(Array.isArray(extra) ? extra : [])];
}

export const DESKTOP_SEARCH_INDEX = Object.freeze(buildDesktopSearchIndex());

// 在桌面索引上搜索；签名与共享 searchSettings 一致，便于替换。
export function searchDesktopSettings(query, options = {}) {
  return searchSettings(query, { index: DESKTOP_SEARCH_INDEX, ...options });
}

// 桌面独有分区的标题键。共享的 SETTINGS_SECTION_LABEL_KEYS 里没有这几个 id，
// 不补就会在搜索结果里显示空标题（用户看到一行空白，不知道该点哪）。
const DESKTOP_SECTION_LABEL_KEYS = Object.freeze({
  presets: 'preset.title.global',
  location: 'world.map.real.places.title',
  ocr: 'settings.imageRecognition.sectionTitle',
  diagnostics: 'diagnostics.title',
});

// 结果去重：同一个分区可能命中多条（如 api 卡里 baseUrl 与 modelList 都命中），
// 界面按分区展示时只保留第一条并计数，避免同张卡重复出现。
export function groupDesktopSearchResults(results, t) {
  const translate = typeof t === 'function' ? t : key => key;
  const groups = [];
  const bySection = new Map();
  (Array.isArray(results) ? results : []).forEach(item => {
    if (!item) return;
    const sectionId = String(item.sectionId || '');
    if (!sectionId) return;
    const existing = bySection.get(sectionId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const group = {
      sectionId,
      title: settingsSectionLabel(sectionId, translate)
        || (DESKTOP_SECTION_LABEL_KEYS[sectionId] ? translate(DESKTOP_SECTION_LABEL_KEYS[sectionId]) : '')
        || sectionId,
      count: 1,
    };
    bySection.set(sectionId, group);
    groups.push(group);
  });
  return groups;
}
