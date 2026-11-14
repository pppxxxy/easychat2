// 桌面设置页：左侧分区导航 + 右侧卡片流。
//
// 分区与 Android 侧的 SECTION_RENDER_ORDER 对齐，**顺序也照抄**（api → sampling →
// persona → appearance → experience → extensions → vector → …）。手机版里「向量记忆」
// 是设置页的一个分区，不是「记忆」标签——记忆标签是会话列表管理。
//
// 桌面上不可用的分区（本地模型 / 工作区 / GitHub / MCP / 安全 / 自动备份 / 语言）
// 不显示入口，避免点进去发现是空的；它们的状态在「扩展」页统一说明。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import ApiCard from './ApiCard.jsx';
import AutoBackupCard from './AutoBackupCard.jsx';
import CharacterLockCard from './CharacterLockCard.jsx';
import DiagnosticsCard from './DiagnosticsCard.jsx';
import GlobalPresetCard from './GlobalPresetCard.jsx';
import LocationCard from './LocationCard.jsx';
import ImageRecognitionCard from './ImageRecognitionCard.jsx';
import AppearanceCard from './AppearanceCard.jsx';
import ChatOptionsCard from './ChatOptionsCard.jsx';
import InlineImageCard from './InlineImageCard.jsx';
import MemorySettingsCard from './MemorySettingsCard.jsx';
import MemoryProvenancePanel from '../memory/MemoryProvenancePanel.jsx';
import MemoryConflictPanel from '../memory/MemoryConflictPanel.jsx';
import PersonaCard from './PersonaCard.jsx';
import SamplingCard from './SamplingCard.jsx';
import useApiConfigs from './useApiConfigs.js';
import { Button, Card } from './ui.jsx';

// 与 Android settings/sectionOrder.js 的可渲染子集同序：
//   api / sampling / persona / appearance / experience / extensions / vector / about
// extensions 在桌面是独立标签页（顶栏「扩展」），故此处不重复列出；
// about 在手机是最后一卡，桌面保留（备份入口归属这一卡，与手机一致）。
const SECTIONS = [
  { id: 'api', key: 'settings.api.title' },
  { id: 'sampling', key: 'settings.sampling.title' },
  { id: 'persona', key: 'settings.persona.title' },
  { id: 'appearance', key: 'settings.appearance.title' },
  { id: 'experience', key: 'settings.global.title' },
  { id: 'presets', key: 'preset.title.global' },
  // 位置：影响提示词注入（[当前位置]），与全局预设同属「对话里给模型什么」的一类。
  { id: 'location', key: 'world.map.real.places.title' },
  { id: 'ocr', key: 'settings.imageRecognition.sectionTitle' },
  { id: 'vector', key: 'settings.vector.title' },
  // 自动备份与手机 SECTION_RENDER_ORDER 同位（security 之后、about 之前）。
  { id: 'security', key: 'settings.security.title' },
  { id: 'autoBackup', key: 'settings.autoBackup.title' },
  { id: 'about', key: 'settings.about.title' },
  // 诊断日志放在最后一屏：它是排障入口，不是日常设置（手机侧也在「关于」附近）。
  { id: 'diagnostics', key: 'diagnostics.title' },
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
  character,
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
        {section === 'experience' ? (
          <>
            <ChatOptionsCard palette={palette} fonts={fonts} />
            {/* 自动配图 + 表情包：手机在 extensions 节，桌面并进「对话体验」——
                两者都是「回复长什么样」的设置，放在一起比单开一节更易找。 */}
            <InlineImageCard palette={palette} fonts={fonts} />
          </>
        ) : null}
        {section === 'presets' ? (
          <GlobalPresetCard palette={palette} fonts={fonts} />
        ) : null}
        {section === 'location' ? (
          <LocationCard palette={palette} fonts={fonts} />
        ) : null}
        {section === 'ocr' ? (
          <ImageRecognitionCard palette={palette} fonts={fonts} />
        ) : null}
        {section === 'vector' ? (
          <>
            <MemorySettingsCard palette={palette} fonts={fonts} character={character} />
            <MemoryProvenancePanel palette={palette} fonts={fonts} character={character} />
            <MemoryConflictPanel palette={palette} fonts={fonts} character={character} />
          </>
        ) : null}
        {section === 'security' ? (
          <CharacterLockCard palette={palette} fonts={fonts} />
        ) : null}
        {section === 'autoBackup' ? (
          <AutoBackupCard palette={palette} fonts={fonts} appVersion={version} />
        ) : null}
        {section === 'diagnostics' ? (
          <DiagnosticsCard palette={palette} fonts={fonts} />
        ) : null}
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