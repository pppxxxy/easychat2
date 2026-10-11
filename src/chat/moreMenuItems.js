// 聊天页「更多」菜单里「其他」分组（低频与系统入口）的条目构造。
//
// 从 ChatScreen.js 原样外提（无行为变化）：条目内容一个字段都没动，只是把这段
// 静态数据从已到行数基线的 ChatScreen 里搬出来（架构棘轮只许收紧，见
// scripts/guard-structure.mjs）。依赖 ChatScreen 状态与回调，故由调用方传入。

export function buildMoreMenuSystemItems({
  t,
  characterId,
  openSessionStats,
  setMemoryProvenanceOpen,
  setNoticeOpen,
  setHubOpen,
  setChatSettingsOpen,
}) {
  const section = t('chat.menu.section.other');
  return [
    {
      key: 'memory-provenance',
      section,
      label: t('chat.menu.memoryProvenance'),
      icon: 'git-network-outline',
      disabled: !characterId,
      onPress: () => setMemoryProvenanceOpen(true),
    },
    {
      key: 'session-stats',
      section,
      label: t('chat.menu.sessionStats'),
      icon: 'stats-chart-outline',
      onPress: openSessionStats,
    },
    {
      key: 'notice',
      section,
      label: t('chat.menu.notice'),
      icon: 'megaphone-outline',
      onPress: () => setNoticeOpen(true),
    },
    {
      key: 'local-logs',
      section,
      label: t('chat.menu.localLogs'),
      icon: 'document-text-outline',
      onPress: () => setHubOpen(true),
    },
    {
      key: 'settings',
      section,
      label: t('chat.menu.settings'),
      icon: 'settings-outline',
      onPress: () => setChatSettingsOpen(true),
    },
  ];
}
