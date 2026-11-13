// 桌面设置页：左侧分区导航 + 右侧卡片流。
//
// 分区与 Android 侧的 SECTION_RENDER_ORDER 对齐（api/sampling/persona/appearance/
// experience/about），暂不可用的分区（本地模型、工作区、MCP、插件等）不显示入口，
// 避免点进去发现是空的。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import ApiCard from './ApiCard.jsx';
import AppearanceCard from './AppearanceCard.jsx';
import ChatOptionsCard from './ChatOptionsCard.jsx';
import PersonaCard from './PersonaCard.jsx';
import SamplingCard from './SamplingCard.jsx';
import useApiConfigs from './useApiConfigs.js';
import { Button, Card } from './ui.jsx';

const SECTIONS = [
  { id: 'api', key: 'settings.api.title' },
  { id: 'sampling', key: 'settings.sampling.title' },
  { id: 'persona', key: 'settings.persona.title' },
  { id: 'appearance', key: 'settings.appearance.title' },
  { id: 'experience', key: 'settings.global.title' },
  { id: 'about', key: 'settings.about.title' },
];

function AboutCard({ palette, fonts, version, onTutorial, onDisclaimer, onBackup }) {
  const { t } = useTranslation();
  return (
    <Card title={t('settings.about.title')} palette={palette} fonts={fonts}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
          {t('settings.about.version')}: {version || t('settings.about.versionUnknown')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <Button label={t('settings.about.tutorial')} onClick={onTutorial} palette={palette} fonts={fonts} />
          <Button label={t('settings.about.disclaimer')} onClick={onDisclaimer} palette={palette} fonts={fonts} />
          <Button label={t('settings.about.backup')} onClick={onBackup} palette={palette} fonts={fonts} />
        </div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint, marginTop: 4 }}>
          https://github.com/pppxxxy/easychat2
        </div>
      </div>
    </Card>
  );
}

export default function SettingsScreen({
  palette,
  fonts,
  version,
  onTutorial,
  onDisclaimer,
  onBackup,
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState('api');
  const api = useApiConfigs();

  const navButton = (item) => {
    const activeNav = section === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSection(item.id)}
        style={{
          textAlign: 'left',
          background: activeNav ? palette.surfaceAlt : 'transparent',
          color: activeNav ? palette.text : palette.textMuted,
          border: `1px solid ${activeNav ? palette.primaryMuted : 'transparent'}`,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: fonts.scaled(12),
          fontWeight: activeNav ? 700 : 500,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        {t(item.key)}
      </button>
    );
  };

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <nav style={{
        width: 180,
        flex: 'none',
        borderRight: `1px solid ${palette.divider}`,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        overflow: 'auto',
      }}
      >
        {SECTIONS.map(navButton)}
      </nav>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
        {section === 'api' ? <ApiCard api={api} palette={palette} fonts={fonts} /> : null}
        {section === 'sampling' ? <SamplingCard palette={palette} fonts={fonts} /> : null}
        {section === 'persona' ? <PersonaCard palette={palette} fonts={fonts} /> : null}
        {section === 'appearance' ? <AppearanceCard palette={palette} fonts={fonts} /> : null}
        {section === 'experience' ? <ChatOptionsCard palette={palette} fonts={fonts} /> : null}
        {section === 'about' ? (
          <AboutCard
            palette={palette}
            fonts={fonts}
            version={version}
            onTutorial={onTutorial}
            onDisclaimer={onDisclaimer}
            onBackup={onBackup}
          />
        ) : null}
      </div>
    </div>
  );
}