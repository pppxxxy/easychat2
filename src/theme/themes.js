export const THEMES = [
  {
    id: 'dark',
    labelKey: 'theme.dark',
    colors: {
      background: '#1a1a2e',
      surface: '#2d2d44',
      surfaceAlt: '#20203a',
      surfaceBorder: '#3a3a58',
      divider: '#35354f',
      primary: '#6c63ff',
      primaryMuted: '#8b85ff',
      primarySoft: '#c8c4ff',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#c9c9e0',
      textFaint: '#8a8aa3',
      danger: '#ff5a5f',
      dangerSoft: '#ff9b9b',
      // 成功/就绪语义色（与 danger 同级）：本地引擎「已加载」等正面状态用。
      success: '#34d399',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#f0f0f0',
      bubbleAssistantText: '#1a1a2e',
    },
  },
  {
    id: 'light',
    labelKey: 'theme.light',
    colors: {
      background: '#f5f5fa',
      surface: '#ffffff',
      surfaceAlt: '#ebebf5',
      surfaceBorder: '#d5d5e4',
      divider: '#e2e2ee',
      primary: '#5b54e8',
      primaryMuted: '#7269f0',
      primarySoft: '#b9b3ff',
      primaryContrast: '#ffffff',
      text: '#1c1c2e',
      textMuted: '#4a4a68',
      textFaint: '#7d7d99',
      danger: '#d64550',
      dangerSoft: '#c25a62',
      // 浅色底上用深绿（对比度足够），色值取自 v5 设计稿的「已加载」绿。
      success: '#1a7a4b',
      overlay: 'rgba(0,0,0,0.35)',
      star: '#f2c14e',
      bubbleAssistant: '#ffffff',
      bubbleAssistantText: '#1c1c2e',
    },
  },
  {
    id: 'blue',
    labelKey: 'theme.blue',
    colors: {
      background: '#0f1b2d',
      surface: '#1b2f4a',
      surfaceAlt: '#142438',
      surfaceBorder: '#2a4463',
      divider: '#233a54',
      primary: '#3b82f6',
      primaryMuted: '#60a5fa',
      primarySoft: '#a8cdff',
      primaryContrast: '#0f1b2d',
      text: '#ffffff',
      textMuted: '#c3d6ee',
      textFaint: '#7f9ab8',
      danger: '#f87171',
      dangerSoft: '#fca5a5',
      success: '#34d399',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#e8f1fe',
      bubbleAssistantText: '#0f1b2d',
    },
  },
  {
    id: 'pink',
    labelKey: 'theme.pink',
    colors: {
      background: '#2a1e18',
      surface: '#3d2c24',
      surfaceAlt: '#33241d',
      surfaceBorder: '#5a4133',
      divider: '#4a352a',
      primary: '#ff9a76',
      primaryMuted: '#ffb699',
      primarySoft: '#ffd6c2',
      primaryContrast: '#2a1e18',
      text: '#ffffff',
      textMuted: '#ecd6ca',
      textFaint: '#bd9a88',
      danger: '#ff7b7b',
      dangerSoft: '#ffb3b3',
      success: '#4ade80',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#fdeee7',
      bubbleAssistantText: '#2a1e18',
    },
  },
  {
    id: 'crimson',
    labelKey: 'theme.crimson',
    colors: {
      background: '#1e1a2e',
      surface: '#2c2743',
      surfaceAlt: '#241f38',
      surfaceBorder: '#463e66',
      divider: '#383253',
      primary: '#a99bf5',
      primaryMuted: '#c0b5f9',
      primarySoft: '#ddd6ff',
      primaryContrast: '#1e1a2e',
      text: '#ffffff',
      textMuted: '#d6d0ec',
      textFaint: '#9a93b8',
      danger: '#f07b8a',
      dangerSoft: '#ffb3bc',
      success: '#34d399',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#efeafe',
      bubbleAssistantText: '#1e1a2e',
    },
  },
  {
    id: 'violet',
    labelKey: 'theme.violet',
    colors: {
      background: '#1a1225',
      surface: '#2a1f3d',
      surfaceAlt: '#231838',
      surfaceBorder: '#4a3566',
      divider: '#3d2d54',
      primary: '#c084fc',
      primaryMuted: '#d8b4fe',
      primarySoft: '#f3e8ff',
      primaryContrast: '#1a1225',
      text: '#f5f0ff',
      textMuted: '#d4c4ee',
      textFaint: '#947eb8',
      danger: '#f87171',
      dangerSoft: '#fca5a5',
      success: '#4ade80',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#fbbf24',
      bubbleAssistant: '#f5f0ff',
      bubbleAssistantText: '#1a1225',
    },
  },
  {
    id: 'emerald',
    labelKey: 'theme.emerald',
    colors: {
      background: '#0f1f1a',
      surface: '#1a332b',
      surfaceAlt: '#142921',
      surfaceBorder: '#2a5445',
      divider: '#234538',
      primary: '#34d399',
      primaryMuted: '#6ee7b7',
      primarySoft: '#a7f3d0',
      primaryContrast: '#0f1f1a',
      text: '#ecfdf5',
      textMuted: '#b8e9d2',
      textFaint: '#6aaa8e',
      danger: '#f87171',
      dangerSoft: '#fca5a5',
      // 本主题 primary 已是绿：success 取更亮一档，避免「运行中」与「品牌色」分不开。
      success: '#6ee7b7',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#fbbf24',
      bubbleAssistant: '#ecfdf5',
      bubbleAssistantText: '#0f1f1a',
    },
  },
  {
    id: 'midnight',
    labelKey: 'theme.midnight',
    colors: {
      background: '#080c14',
      surface: '#121a2b',
      surfaceAlt: '#0e1524',
      surfaceBorder: '#1e2d4a',
      divider: '#182238',
      primary: '#38bdf8',
      primaryMuted: '#7dd3fc',
      primarySoft: '#bae6fd',
      primaryContrast: '#080c14',
      text: '#e0f2fe',
      textMuted: '#a5d8f7',
      textFaint: '#5a8caf',
      danger: '#f87171',
      dangerSoft: '#fca5a5',
      success: '#34d399',
      overlay: 'rgba(0,0,0,0.6)',
      star: '#fbbf24',
      bubbleAssistant: '#e0f2fe',
      bubbleAssistantText: '#080c14',
    },
  },
  {
    // 粉白配色：整条色板只有粉与白两族（含深玫红/莓紫等粉色深浅档）。
    // 底色是近白粉、表面纯白，主色取足够深的玫红以保证在浅底上仍达 WCAG AA
    // （primary #c2185b 对 surface 5.87:1、对 background 5.50:1）——浅粉当文字色
    // 会在白底上隐形，所以「粉」的浓度只放在装饰档（primarySoft / surfaceAlt）。
    id: 'pinkWhite',
    labelKey: 'theme.pinkWhite',
    colors: {
      background: '#fff5f8',
      surface: '#ffffff',
      surfaceAlt: '#ffeef4',
      surfaceBorder: '#ffd6e4',
      divider: '#ffe0ea',
      primary: '#c2185b',
      primaryMuted: '#e0508a',
      primarySoft: '#ffc2d8',
      primaryContrast: '#ffffff',
      text: '#5b2436',
      textMuted: '#8a4a63',
      textFaint: '#b57e93',
      danger: '#c62b52',
      dangerSoft: '#e5809b',
      // 本主题主色已是粉：success 取更深一档的莓紫，靠明度与主色区分（同 emerald 口径）。
      success: '#ad1457',
      // 遮罩也用粉调深色，避免纯黑破坏「只有粉与白」的整体观感。
      overlay: 'rgba(91,36,54,0.35)',
      // 星标原本是暖黄，会破坏单一色相；改为粉色档。
      star: '#e0508a',
      bubbleAssistant: '#ffffff',
      bubbleAssistantText: '#5b2436',
    },
  },
  {
    // 自定义主题的出厂底稿：中性浅色，用户在此之上改任意槽位。
    // 它不是「内置风格」而是编辑起点，故用中性石板色而非某个主题的复制品。
    id: 'custom',
    labelKey: 'theme.custom',
    colors: {
      background: '#f6f6f8',
      surface: '#ffffff',
      surfaceAlt: '#ededf1',
      surfaceBorder: '#d6d6de',
      divider: '#e3e3e9',
      primary: '#4a5568',
      primaryMuted: '#718096',
      primarySoft: '#cbd5e0',
      primaryContrast: '#ffffff',
      text: '#1f2430',
      textMuted: '#4a5162',
      textFaint: '#7c8496',
      danger: '#b3261e',
      dangerSoft: '#e08b86',
      success: '#1f6b45',
      overlay: 'rgba(0,0,0,0.35)',
      star: '#c99a00',
      bubbleAssistant: '#ffffff',
      bubbleAssistantText: '#1f2430',
    },
  },
];

export const DEFAULT_THEME_ID = 'dark';

// 可自定义配色的主题 id。getTheme 只对它应用用户配色，其余内置主题忽略覆盖值。
export const CUSTOM_THEME_ID = 'custom';

// 自定义配色可编辑的槽位，按「改了看得出全局变化」的维度分组。
// 只暴露这些基础槽位：primaryAlpha / dangerSurface / accentText 等派生 token
// 仍由 getTheme 从它们算出，避免自定义层出现两处互相打架的重复色。
export const CUSTOM_COLOR_GROUPS = [
  { id: 'base', labelKey: 'theme.custom.group.base', fields: ['background', 'surface', 'surfaceAlt', 'surfaceBorder', 'divider'] },
  { id: 'brand', labelKey: 'theme.custom.group.brand', fields: ['primary', 'primaryMuted', 'primarySoft', 'primaryContrast'] },
  { id: 'text', labelKey: 'theme.custom.group.text', fields: ['text', 'textMuted', 'textFaint'] },
  { id: 'bubble', labelKey: 'theme.custom.group.bubble', fields: ['bubbleAssistant', 'bubbleAssistantText'] },
  { id: 'status', labelKey: 'theme.custom.group.status', fields: ['danger', 'dangerSoft', 'success', 'star'] },
];

export const CUSTOM_COLOR_FIELDS = CUSTOM_COLOR_GROUPS.flatMap(group => group.fields);

// 每个槽位的人话名（编辑器里显示），避免直接抛 token 名给用户。
export const CUSTOM_COLOR_FIELD_KEYS = {
  background: 'theme.custom.field.background',
  surface: 'theme.custom.field.surface',
  surfaceAlt: 'theme.custom.field.surfaceAlt',
  surfaceBorder: 'theme.custom.field.surfaceBorder',
  divider: 'theme.custom.field.divider',
  primary: 'theme.custom.field.primary',
  primaryMuted: 'theme.custom.field.primaryMuted',
  primarySoft: 'theme.custom.field.primarySoft',
  primaryContrast: 'theme.custom.field.primaryContrast',
  text: 'theme.custom.field.text',
  textMuted: 'theme.custom.field.textMuted',
  textFaint: 'theme.custom.field.textFaint',
  bubbleAssistant: 'theme.custom.field.bubbleAssistant',
  bubbleAssistantText: 'theme.custom.field.bubbleAssistantText',
  danger: 'theme.custom.field.danger',
  dangerSoft: 'theme.custom.field.dangerSoft',
  success: 'theme.custom.field.success',
  star: 'theme.custom.field.star',
};

// 取色板预置色：中性档 + 粉白档 + 各内置主题的主色/底色，方便一键靠近已有风格。
export const CUSTOM_COLOR_PRESETS = [
  '#ffffff', '#f6f6f8', '#ededf1', '#d6d6de', '#8a8a9a', '#4a5162', '#1f2430', '#000000',
  '#fff5f8', '#ffeef4', '#ffd6e4', '#ffc2d8', '#ff8fb8', '#e0508a', '#c2185b', '#ad1457',
  '#f5f5fa', '#ebebf5', '#d5d5e4', '#5b54e8', '#3b82f6', '#c084fc', '#34d399', '#f2c14e',
  '#d64550', '#1a7a4b', '#fbbf24', '#38bdf8', '#6c63ff', '#a99bf5', '#1a1a2e', '#2d2d44',
];

// 三位或六位十六进制。只接受 # 前缀的写法，避免 rgba()/色名等半截值混进主题层。
export function isValidHexColor(value) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value == null ? '' : value).trim());
}

// 归一化用户配色：只保留已知槽位 + 合法色值，其余丢弃（不是抛错也不是回落默认——
// 缺的槽位由 getTheme 用自定义主题底稿补齐，这样以后加槽位不会让旧配置整体失效）。
export function normalizeCustomColors(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  CUSTOM_COLOR_FIELDS.forEach(field => {
    const value = String(source[field] == null ? '' : source[field]).trim();
    if (isValidHexColor(value)) result[field] = value;
  });
  return result;
}

// 自定义主题的完整生效色板：底稿 + 用户覆盖。编辑器用它做「未改动槽位」的初值。
export function resolveCustomColors(raw) {
  const base = THEMES.find(theme => theme.id === CUSTOM_THEME_ID);
  return { ...(base ? base.colors : {}), ...normalizeCustomColors(raw) };
}

// WCAG 2.1 相对亮度（sRGB）。非法输入返回 0（对比度会退化成「几乎不可读」，便于测试抓出）。
export function relativeLuminance(hex) {
  const clean = String(hex == null ? '' : hex).replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return 0;
  const channels = [0, 2, 4]
    .map(i => parseInt(full.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

// WCAG 2.1 对比度，1 ~ 21。供主题层派生前景色，以及 tests/themeContrast.test.mjs 复用同一公式。
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// 聊天气泡风格偏好（存储于聊天设置）：圆润（默认）/ 卡片 / 无底纹。
export const BUBBLE_STYLES = ['rounded', 'card', 'plain'];

export function hexToRgba(hex, alpha = 1) {
  if (!hex || typeof hex !== 'string') return `rgba(108,99,255,${alpha})`;
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex;
}

// customColors 只对「自定义」主题生效；内置主题忽略它（避免误传把内置风格改花）。
// 派生 token（primaryAlpha / dangerSurface / accentText / surfaceAlpha…）一律从
// 合并后的色板算出，所以用户改了 primary，透明度助手与强调前景会跟着变。
export function getTheme(id, customColors) {
  const found = THEMES.find(theme => theme.id === id) || THEMES[0];
  const overrides = found.id === CUSTOM_THEME_ID ? normalizeCustomColors(customColors) : null;
  const base = overrides ? { ...found.colors, ...overrides } : found.colors;
  const primary = base.primary;
  const primaryMuted = base.primaryMuted;
  const danger = base.danger;
  const success = base.success;
  const primaryContrast = base.primaryContrast;
  const colors = {
    ...base,
    primaryAlpha: (alpha = 0.1) => hexToRgba(primary, alpha),
    primaryMutedAlpha: (alpha = 0.35) => hexToRgba(primaryMuted, alpha),
    dangerAlpha: (alpha = 0.1) => hexToRgba(danger, alpha),
    // 成功/就绪（本地引擎"已加载"等）的浅底：与 dangerSurface 同款派生口径。
    successSurface: hexToRgba(success, 0.12),
    // 表面色的半透明版本：用于「浮在滚动内容之上」的浮层/操作条底色。
    surfaceAlpha: (alpha = 0.3) => hexToRgba(base.surface, alpha),
    // 语义派生 token：把散落在样式里的硬编码色收敛回主题体系。
    // dangerSurface 用于错误气泡底；dangerText* 保证各主题下正文可读。
    dangerSurface: hexToRgba(danger, 0.12),
    dangerTextStrong: danger,
    dangerTextSoft: hexToRgba(danger, 0.82),
    // 用户气泡底色即 primary，引用名/引用正文用 primaryContrast 派生的半透明，
    // 避免在浅色/高亮 primary（如紫罗兰 #c084fc）上白色文字对比不足。
    quoteOnPrimary: hexToRgba(primaryContrast, 0.95),
    quoteOnPrimaryMuted: hexToRgba(primaryContrast, 0.72),
    // 搜索命中高亮：暖黄底 + 深字，跨主题可读。
    highlightBg: 'rgba(255,214,102,0.6)',
    highlightText: '#3a2a00',
    // 面板内按钮（HTML 卡片注入的 <button>）：不随主题的深色底，故文字用固定浅色。
    panelButtonBg: '#344f5d',
    panelButtonText: '#eef4f7',
    // 行内代码/代码块的强调色：需在深色与浅色 surface 上都可读（dangerSoft 两向都够）。
    codeText: base.dangerSoft,
    // 「主色系强调前景」——给**文字与图标**用的强调色。
    // 背景：primarySoft 是「浅色调」，在深色底上可读（dark 8.15:1），但在浅色主题的
    // 白底/浅灰底上只有 1.92:1（light）——当文字色用等于隐形。故这里在 primary 与
    // primarySoft 之间挑「在 surface 上对比度更高」的那个：浅底主题取 primary
    // （light 5.41:1），深底主题取 primarySoft。装饰性用途（背景/边框）继续直接用
    // primarySoft，不走这个 token。口径与 dangerTextStrong / codeText 一致：
    // 「按主题挑一个可读前景」，不新增颜色取值。
    accentText: contrastRatio(primary, base.surface) >= contrastRatio(base.primarySoft, base.surface)
      ? primary
      : base.primarySoft,
  };
  return { ...found, colors };
}

export const FONT_SCALES = [
  { id: 'default', labelKey: 'fontScale.default', scale: 1 },
  { id: 'system', labelKey: 'fontScale.system', scale: null },
  { id: 'small', labelKey: 'fontScale.small', scale: 0.9 },
  { id: 'medium', labelKey: 'fontScale.medium', scale: 1.1 },
  { id: 'large', labelKey: 'fontScale.large', scale: 1.25 },
  { id: 'xlarge', labelKey: 'fontScale.xlarge', scale: 1.4 },
];

export const DEFAULT_FONT_SCALE_ID = 'default';

export function getFontOption(id) {
  return FONT_SCALES.find(option => option.id === id) || FONT_SCALES[0];
}

export function resolveFontScale(id, systemScale) {
  const option = getFontOption(id);
  if (option.scale === null) {
    const value = Number(systemScale);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
  return option.scale;
}
