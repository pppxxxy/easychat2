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
    label: '粉红色',
    colors: {
      background: '#2a1620',
      surface: '#3d2233',
      surfaceAlt: '#331a28',
      surfaceBorder: '#573349',
      divider: '#4a2a3c',
      primary: '#f472b6',
      primaryMuted: '#f9a8d4',
      primarySoft: '#fbcfe8',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#eccbdd',
      textFaint: '#b98aa3',
      danger: '#ff7b8a',
      dangerSoft: '#ffb3bc',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#fdeaf4',
      bubbleAssistantText: '#2a1620',
    },
  },
  {
    id: 'crimson',
    label: '深红色',
    colors: {
      background: '#260f13',
      surface: '#3a1a20',
      surfaceAlt: '#2f1218',
      surfaceBorder: '#5a2b32',
      divider: '#4a2229',
      primary: '#e04a5f',
      primaryMuted: '#f2717f',
      primarySoft: '#ffb0b8',
      primaryContrast: '#ffffff',
      text: '#ffffff',
      textMuted: '#e8c9cd',
      textFaint: '#b8898f',
      danger: '#ff6b6b',
      dangerSoft: '#ffb3b3',
      overlay: 'rgba(0,0,0,0.55)',
      star: '#f2c14e',
      bubbleAssistant: '#fbe9ea',
      bubbleAssistantText: '#260f13',
    },
  },
];

export const DEFAULT_THEME_ID = 'dark';

export function getTheme(id) {
  return THEMES.find(theme => theme.id === id) || THEMES[0];
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
