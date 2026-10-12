// 工作区设置面板的行元数据（纯数据构造，无 JSX）。
// 从 WorkspaceSettingsSheet 外提：设置行与动作行是「数据 → 列表」的一层，
// 与面板的渲染/状态无关，独立成模块便于测试与复用。

import { HOOK_EVENTS, parseWorkspaceHooks } from './hooks.js';
import { WORKSPACE_TEMPLATES } from './templates.js';

const MODE_CHOICES = ['ask', 'read', 'write'];

export function buildSettingsRows({
  t,
  activeModel,
  thinkingKey,
  mode,
  activeCharacter,
  usage,
  retentionEffective,
  skillsCount,
  agentsCount,
  sessionEventTotal,
  mcpEnabled,
  mcpTotal,
  teamsCount,
  boardTopicsCount,
  commandsCount,
  permissionRulesCount,
  hooksText,
}) {
  return [
    {
      id: 'model',
      icon: 'cube-outline',
      label: t('workspace.settings.model'),
      value: activeModel || t('workspace.settings.model.empty'),
    },
    {
      id: 'thinking',
      icon: 'bulb-outline',
      label: t('workspace.settings.thinking'),
      value: t(`workspace.panel.thinking.${thinkingKey}`),
    },
    {
      id: 'mode',
      icon: 'options-outline',
      label: t('workspace.settings.mode'),
      value: t(`settings.workspace.mode.${MODE_CHOICES.includes(mode) ? mode : 'ask'}`),
    },
    {
      id: 'character',
      icon: 'person-circle-outline',
      label: t('workspace.settings.character'),
      value: (activeCharacter && activeCharacter.name) || t('workspace.settings.character.none'),
    },
    {
      id: 'usage',
      icon: 'analytics-outline',
      label: t('workspace.settings.usage'),
      value: usage ? `${Math.round((usage.ratio || 0) * 100)}%` : t('workspace.settings.usage.empty'),
    },
    {
      // P1-11：旁路数据的保留口径（三个上限）。摘要用生效值，改完立即反映。
      id: 'retention',
      icon: 'archive-outline',
      label: t('workspace.settings.retention'),
      value: t('workspace.settings.retention.value', {
        history: retentionEffective.historyKeep,
        rollback: retentionEffective.rollbackKeep,
        kb: retentionEffective.sessionEventsMaxKb,
      }),
    },
    {
      id: 'skills',
      icon: 'sparkles-outline',
      label: t('workspace.settings.skills'),
      value: skillsCount > 0
        ? t('workspace.settings.skills.count', { count: skillsCount })
        : t('workspace.settings.skills.emptyShort'),
    },
    {
      id: 'agents',
      icon: 'people-outline',
      label: t('workspace.settings.agents'),
      value: agentsCount > 0
        ? t('workspace.settings.agents.count', { count: agentsCount })
        : t('workspace.settings.agents.emptyShort'),
    },
    {
      id: 'sessionLog',
      icon: 'pulse-outline',
      label: t('workspace.settings.events'),
      value: sessionEventTotal > 0
        ? t('workspace.settings.events.count', { count: sessionEventTotal })
        : t('workspace.settings.events.emptyShort'),
    },
    {
      id: 'mcp',
      icon: 'apps-outline',
      label: t('workspace.settings.mcp'),
      value: mcpEnabled > 0
        ? t('workspace.settings.mcp.count', { enabled: mcpEnabled, total: mcpTotal })
        : (mcpTotal > 0 ? t('workspace.settings.mcp.allOff') : t('workspace.settings.mcp.emptyShort')),
    },
    {
      id: 'teams',
      icon: 'people-outline',
      label: t('workspace.settings.teams'),
      value: teamsCount > 0
        ? t('workspace.settings.teams.count', { count: teamsCount })
        : t('workspace.settings.teams.emptyShort'),
    },
    {
      id: 'board',
      icon: 'albums-outline',
      label: t('workspace.settings.board'),
      value: boardTopicsCount > 0
        ? t('workspace.settings.board.count', { count: boardTopicsCount })
        : t('workspace.settings.board.emptyShort'),
    },
    {
      id: 'commands',
      icon: 'terminal-outline',
      label: t('workspace.settings.commands'),
      value: commandsCount > 0
        ? t('workspace.settings.commands.count', { count: commandsCount })
        : t('workspace.settings.commands.emptyShort'),
    },
    {
      id: 'permissions',
      icon: 'shield-checkmark-outline',
      label: t('workspace.settings.permissions'),
      value: permissionRulesCount > 0
        ? t('workspace.settings.permissions.count', { count: permissionRulesCount })
        : t('workspace.settings.permissions.emptyShort'),
    },
    {
      id: 'hooks',
      icon: 'git-branch-outline',
      label: t('workspace.settings.hooks'),
      value: (() => {
        const parsed = parseWorkspaceHooks(hooksText);
        const count = HOOK_EVENTS.reduce((sum, event) => sum + (Array.isArray(parsed[event]) ? parsed[event].length : 0), 0);
        return count > 0 ? t('workspace.settings.hooks.count', { count }) : 'hooks.json';
      })(),
    },
    {
      id: 'templates',
      icon: 'layers-outline',
      label: t('workspace.settings.templates'),
      value: t('workspace.settings.templates.count', { count: WORKSPACE_TEMPLATES.length }),
    },
  ];
}

export function buildActionRows({ t, importBusy, onImportFile, onClose, onOpenPanel }) {
  return [
    {
      id: 'import',
      icon: 'download-outline',
      label: t('workspace.settings.import'),
      hint: t('workspace.settings.import.hint'),
      busy: importBusy,
      onPress: () => onImportFile && onImportFile(),
    },
    {
      id: 'export',
      icon: 'document-text-outline',
      label: t('workspace.settings.export'),
      hint: t('workspace.settings.export.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('docx');
      },
    },
    {
      id: 'history',
      icon: 'folder-open-outline',
      label: t('workspace.settings.files'),
      hint: t('workspace.settings.history.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('viewer');
      },
    },
    {
      id: 'env',
      icon: 'construct-outline',
      label: t('workspace.settings.env'),
      hint: t('workspace.settings.env.hint'),
      onPress: () => {
        if (onClose) onClose();
        if (onOpenPanel) onOpenPanel('catalog');
      },
    },
  ];
}
