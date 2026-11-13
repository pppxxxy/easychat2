// 扩展页（桌面）：桌面版尚未支持的能力入口 + 禁用态说明。
//
// 设计口径（requirements「首版不含」）：这些功能在首版界面里**不隐藏入口**，而是以
// 明确的「桌面版暂不支持」说明呈现——隐藏会让用户以为功能丢了。每个入口点开给出
// 一句话说明它为什么不在桌面版（依赖原生能力），以及在手机上可以怎么用。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { CAPABILITIES } from '../platform/capabilities.js';
import { Card } from '../settings/ui.jsx';

const ENTRIES = [
  { id: 'imageGen', key: 'imageGen.title', hint: 'desktop.unsupported.imageGen' },
  { id: 'tts', key: 'settings.global.tts', hint: 'desktop.unsupported.tts' },
  { id: 'transcription', key: 'settings.global.transcription', hint: 'desktop.unsupported.transcription' },
  { id: 'localModels', key: 'desktop.entry.localModels', hint: 'desktop.unsupported.localModels' },
  { id: 'workspaceTools', key: 'desktop.entry.workspace', hint: 'desktop.unsupported.workspace' },
  { id: 'plugins', key: 'desktop.entry.plugins', hint: 'desktop.unsupported.plugins' },
  { id: 'mcp', key: 'desktop.entry.mcp', hint: 'desktop.unsupported.mcp' },
  { id: 'screenWatch', key: 'desktop.entry.screenWatch', hint: 'desktop.unsupported.screenWatch' },
  { id: 'proactiveMessages', key: 'settings.global.moments', hint: 'desktop.unsupported.proactive' },
  { id: 'scheduledTasks', key: 'desktop.entry.scheduled', hint: 'desktop.unsupported.scheduled' },
];

export default function ExtensionScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState('');

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('app.tab.extension')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>
          {t('desktop.unsupported.intro')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ENTRIES.map(entry => {
            const available = CAPABILITIES[entry.id] === true;
            const open = openId === entry.id;
            return (
              <div key={entry.id} style={{ border: `1px solid ${palette.divider}`, borderRadius: 10, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? '' : entry.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    background: open ? palette.surfaceAlt : 'transparent',
                    color: palette.text,
                    border: 'none',
                    padding: '9px 12px',
                    cursor: 'pointer',
                    fontSize: fonts.scaled(13),
                    textAlign: 'left',
                  }}
                >
                  <span>{t(entry.key)}</span>
                  <span style={{
                    fontSize: fonts.scaled(10),
                    color: available ? palette.success : palette.textFaint,
                    border: `1px solid ${available ? palette.success : palette.divider}`,
                    borderRadius: 999,
                    padding: '1px 8px',
                    flex: 'none',
                  }}
                  >
                    {available ? t('desktop.status.available') : t('desktop.status.unsupported')}
                  </span>
                </button>
                {open ? (
                  <div style={{
                    padding: '0 12px 10px',
                    fontSize: fonts.scaled(11),
                    lineHeight: 1.75,
                    color: palette.textMuted,
                  }}
                  >
                    {t(entry.hint)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}