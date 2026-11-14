// 桌面设置页：左侧分区导航 + 右侧卡片流。
//
// 分区与 Android 侧的 SECTION_RENDER_ORDER 对齐，**顺序也照抄**（api → sampling →
// persona → appearance → experience → extensions → vector → …）。手机版里「向量记忆」
// 是设置页的一个分区，不是「记忆」标签——记忆标签是会话列表管理。
//
// 桌面上不可用的分区（本地模型 / 工作区 / GitHub / MCP / 安全 / 自动备份 / 语言）
// 不显示入口，避免点进去发现是空的；它们的状态在「扩展」页统一说明。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import ApiCard from './ApiCard.jsx';
import AutoBackupCard from './AutoBackupCard.jsx';
import CharacterLockCard from './CharacterLockCard.jsx';
import DiagnosticsCard from './DiagnosticsCard.jsx';
import GlobalPresetCard from './GlobalPresetCard.jsx';
import LocationCard from './LocationCard.jsx';
import ImageRecognitionCard from './ImageRecognitionCard.jsx';
import AppearanceCard from './AppearanceCard.jsx';
import CustomThemeCard from './CustomThemeCard.jsx';
import ChatOptionsCard from './ChatOptionsCard.jsx';
import InlineImageCard from './InlineImageCard.jsx';
import MemorySettingsCard from './MemorySettingsCard.jsx';
import MemoryProvenancePanel from '../memory/MemoryProvenancePanel.jsx';
import MemoryConflictPanel from '../memory/MemoryConflictPanel.jsx';
import PersonaCard from './PersonaCard.jsx';
import SamplingCard from './SamplingCard.jsx';
import TtsCard from './TtsCard.jsx';
import TranscriptionCard from './TranscriptionCard.jsx';
import useApiConfigs from './useApiConfigs.js';
import { groupDesktopSearchResults, searchDesktopSettings } from './desktopSearchIndex.js';
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

function AboutCard({ palette, fonts, version, onTutorial, onDisclaimer, onBackup, onAnnouncement, hasAnnouncement }) {
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
          {/* 更新说明：与手机「关于 → 更新说明」同位。只读缓存、不联网。
              手机在无缓存时显示「暂无更新说明」而不是把入口藏起来——这里照搬，
              用户才知道「有这个功能，只是当前没有内容」。 */}
          <Button
            label={hasAnnouncement ? t('announcement.entry') : t('announcement.entryNone')}
            onClick={onAnnouncement}
            palette={palette}
            fonts={fonts}
            disabled={!hasAnnouncement}
          />
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
  onAnnouncement,
  hasAnnouncement = false,
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState('api');
  // 设置搜索：桌面分区与手机不同，索引在 desktopSearchIndex.js 里做过映射，
  // 保证「搜到的每一条都能跳到真实存在的卡」。
  const [query, setQuery] = useState('');
  const searchGroups = useMemo(
    () => (query.trim() ? groupDesktopSearchResults(searchDesktopSettings(query, { t }), t) : []),
    [query, t]
  );
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
        {/* 设置搜索：手机在设置页右上角；桌面放在左侧导航下方，输入即出结果，
            点结果跳到对应分区。 */}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('settings.search.placeholder')}
            aria-label={t('settings.search.placeholder')}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: palette.surface,
              color: palette.text,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '6px 8px',
              fontSize: fonts.scaled(12),
            }}
          />
          {query.trim() ? (
            searchGroups.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {searchGroups.map(group => (
                  <button
                    key={group.sectionId}
                    type="button"
                    onClick={() => {
                      setSection(group.sectionId);
                      setQuery('');
                    }}
                    style={{
                      textAlign: 'left',
                      background: 'transparent',
                      color: palette.textMuted,
                      border: 'none',
                      borderRadius: 6,
                      padding: '4px 6px',
                      fontSize: fonts.scaled(11),
                      cursor: 'pointer',
                    }}
                  >
                    {group.title}
                    {group.count > 1 ? ` (${group.count})` : ''}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint, padding: '2px 6px' }}>
                {t('settings.search.empty')}
              </div>
            )
          ) : null}
        </div>
      </nav>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
        {section === 'api' ? <ApiCard api={api} palette={palette} fonts={fonts} /> : null}
        {section === 'sampling' ? <SamplingCard palette={palette} fonts={fonts} /> : null}
        {section === 'persona' ? <PersonaCard palette={palette} fonts={fonts} /> : null}
        {section === 'appearance' ? (
          <>
            <AppearanceCard palette={palette} fonts={fonts} />
            {/* 自定义配色：手机从「外观 → 自定义配色」进；桌面同分区内联展开。 */}
            <CustomThemeCard palette={palette} fonts={fonts} />
          </>
        ) : null}
        {section === 'experience' ? (
          <>
            <ChatOptionsCard palette={palette} fonts={fonts} />
            {/* 自动配图 + 表情包：手机在 extensions 节，桌面并进「对话体验」——
                两者都是「回复长什么样」的设置，放在一起比单开一节更易找。 */}
            <InlineImageCard palette={palette} fonts={fonts} />
            {/* 语音播报 / 语音转文字：手机在「功能扩展」节里，桌面并进「对话体验」。
                两项在桌面都真的可用：播报走 Web Speech（系统引擎）或
                HTMLAudioElement（云端引擎，见 platform/audio.js）；
                转写是纯 HTTP，走共享 transcription.js。 */}
            <TtsCard palette={palette} fonts={fonts} />
            <TranscriptionCard palette={palette} fonts={fonts} />
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
            onAnnouncement={onAnnouncement}
            hasAnnouncement={hasAnnouncement}
            onBackup={onBackup}
          />
        ) : null}
      </div>
    </div>
  );
}