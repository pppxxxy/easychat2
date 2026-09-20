export const THEMES = [
  {
    id: 'dark',
    label: '深色',
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
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#f0f0f0',
      bubbleAssistantText: '#1a1a2e',
    },
  },
  {
    id: 'light',
    label: '浅色',
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
      overlay: 'rgba(0,0,0,0.35)',
      star: '#f2c14e',
      bubbleAssistant: '#ffffff',
      bubbleAssistantText: '#1c1c2e',
    },
  },
  {
    id: 'blue',
    label: '蓝色',
    colors: {
      background: '#0f1b2d',
      surface: '#1b2f4a',
      surfaceAlt: '#142438',
      surfaceBorder: '#2a4463',
      divider: '#233a54',
      primary: '#3b82f6',
      primaryMuted: '#60a5fa',
      primarySoft: '#a8cdff',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#c3d6ee',
      textFaint: '#7f9ab8',
      danger: '#f87171',
      dangerSoft: '#fca5a5',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#e8f1fe',
      bubbleAssistantText: '#0f1b2d',
    },
  },
  {
    id: 'pink',
    label: '蜜桃',
    colors: {
      background: '#2a1e18',
      surface: '#3d2c24',
      surfaceAlt: '#33241d',
      surfaceBorder: '#5a4133',
      divider: '#4a352a',
      primary: '#ff9a76',
      primaryMuted: '#ffb699',
      primarySoft: '#ffd6c2',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#ecd6ca',
      textFaint: '#bd9a88',
      danger: '#ff7b7b',
      dangerSoft: '#ffb3b3',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#fdeee7',
      bubbleAssistantText: '#2a1e18',
    },
  },
  {
    id: 'crimson',
    label: '薰衣草',
    colors: {
      background: '#1e1a2e',
      surface: '#2c2743',
      surfaceAlt: '#241f38',
      surfaceBorder: '#463e66',
      divider: '#383253',
      primary: '#a99bf5',
      primaryMuted: '#c0b5f9',
      primarySoft: '#ddd6ff',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#d6d0ec',
      textFaint: '#9a93b8',
      danger: '#f07b8a',
      dangerSoft: '#ffb3bc',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#efeafe',
      bubbleAssistantText: '#1e1a2e',
    },
  },
];

export const DEFAULT_THEME_ID = 'dark';

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

export function getTheme(id) {
  const found = THEMES.find(theme => theme.id === id) || THEMES[0];
  const primary = found.colors.primary;
  const primaryMuted = found.colors.primaryMuted;
  const colors = {
    ...found.colors,
    primaryAlpha: (alpha = 0.1) => hexToRgba(primary, alpha),
    primaryMutedAlpha: (alpha = 0.35) => hexToRgba(primaryMuted, alpha),
  };
  return { ...found, colors };
}

export const FONT_SCALES = [
  { id: 'default', label: '默认', scale: 1 },
  { id: 'system', label: '跟随系统', scale: null },
  { id: 'small', label: '小', scale: 0.9 },
  { id: 'medium', label: '中', scale: 1.1 },
  { id: 'large', label: '大', scale: 1.25 },
  { id: 'xlarge', label: '特大', scale: 1.4 },
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
