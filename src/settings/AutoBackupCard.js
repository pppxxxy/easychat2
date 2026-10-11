import React from 'react';
import { Text } from 'react-native';

import { Card, CollapsibleSection } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import useAutoBackupSettings from './useAutoBackupSettings.js';
import AutoBackupSection from './sections/AutoBackupSection.js';

// 自动备份设置卡：自持状态（hook 在这里调用），SettingsScreen 只负责把它放在正确位置。
// 独立成组件是为了不把 SettingsScreen 继续撑大（卡片 / hook / 内容都自包含）。
export default function AutoBackupCard({ styles, flash, onLayout, open, onToggle }) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const autoBackup = useAutoBackupSettings();
  const summary = autoBackup.autoBackupSettings.enabled
    ? t('settings.autoBackup.summary.on')
    : t('settings.autoBackup.summary.off');
  return (
    <Card
      style={[styles.sectionCard, flash && styles.sectionCardFlash]}
      onLayout={event => onLayout(event.nativeEvent.layout.y)}
    >
      <CollapsibleSection
        title={t('settings.autoBackup.title')}
        icon="cloud-upload-outline"
        open={open}
        onToggle={onToggle}
        right={<Text style={styles.collapseSummary} numberOfLines={1}>{summary}</Text>}
      >
        <AutoBackupSection {...autoBackup} styles={styles} theme={theme} t={t} />
      </CollapsibleSection>
    </Card>
  );
}
