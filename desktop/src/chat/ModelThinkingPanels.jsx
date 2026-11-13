// 模型 / 思考切换面板（桌面）：对应手机 ModelPanelModal 与 ThinkingPanelModal 的在线部分。
//
// 与手机的差异只有「本地模型」整块（要 llama.cpp 原生库，桌面不提供，扩展页已如实说明）。
// 展示口径照抄手机：来源 chips → 该来源的模型列表（点选即写回 activeModel）；
// 思考面板：能力不支持时给明确说明，depth/display 用共享层常量渲染 chips。
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { THINKING_DISPLAY_KEYS, THINKING_LEVEL_KEYS } from '../../../src/chat/chatConstants.js';
import { Button } from '../settings/ui.jsx';

function Modal({ title, onClose, palette, fonts, children, width = 560 }) {
  const { t } = useTranslation();
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: `min(${width}px, 94vw)`,
          maxHeight: '86vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 18,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{title}</strong>
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
            style={{ background: 'transparent', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: 16 }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ModelPanel({
  open,
  onClose,
  apiConfigs,
  modelSourceId,
  setModelSourceId,
  onSelectModel,
  busy,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const source = apiConfigs.find(item => item.id === modelSourceId) || apiConfigs[0] || null;
  const models = (source && Array.isArray(source.models)) ? source.models : [];

  const chip = active => ({
    background: active ? palette.primary : 'transparent',
    color: active ? palette.primaryContrast : palette.textMuted,
    border: `1px solid ${active ? palette.primary : palette.divider}`,
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: fonts.scaled(12),
    cursor: busy ? 'default' : 'pointer',
  });

  return (
    <Modal title={t('chat.modelPanel.title')} onClose={onClose} palette={palette} fonts={fonts}>
      <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.modelPanel.source')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {apiConfigs.map(config => (
          <button
            key={config.id}
            type="button"
            disabled={busy}
            onClick={() => setModelSourceId(config.id)}
            style={chip(config.id === source?.id)}
          >
            {config.name || t('chat.modelPanel.unnamedConfig')}
          </button>
        ))}
      </div>
      <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.modelPanel.model')}</div>
      {models.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>{t('chat.modelPanel.emptyModels')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {models.map(model => {
            const active = source && source.activeModel === model;
            return (
              <button
                key={model}
                type="button"
                disabled={busy}
                onClick={() => onSelectModel(source.id, model)}
                style={{
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  background: active ? palette.surfaceAlt : 'transparent',
                  color: palette.text,
                  border: `1px solid ${active ? palette.primaryMuted : palette.divider}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: fonts.scaled(12),
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model}</span>
                {active ? (
                  <span style={{ color: palette.primaryMuted || palette.primary, flex: 'none' }}>
                    {t('chat.modelPanel.current')}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('desktop.modelPanel.noLocal')}</div>
    </Modal>
  );
}

export function ThinkingPanel({
  open,
  onClose,
  supported,
  thinking,
  levels,
  displays,
  onApply,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const chip = active => ({
    background: active ? palette.primary : 'transparent',
    color: active ? palette.primaryContrast : palette.textMuted,
    border: `1px solid ${active ? palette.primary : palette.divider}`,
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: fonts.scaled(12),
    cursor: 'pointer',
  });

  return (
    <Modal title={t('chat.thinkingPanel.title')} onClose={onClose} palette={palette} fonts={fonts} width={480}>
      {!supported ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {t('chat.thinkingPanel.unsupported')}
        </div>
      ) : null}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fonts.scaled(12) }}>
        <input
          type="checkbox"
          checked={thinking.enabled === true}
          disabled={!supported}
          onChange={event => onApply({ enabled: event.target.checked })}
        />
        <span>{t('chat.thinkingPanel.enable')}</span>
      </label>
      <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.thinkingPanel.depth')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(levels || []).map(level => (
          <button
            key={level}
            type="button"
            disabled={!supported || !thinking.enabled}
            onClick={() => onApply({ level })}
            style={chip(thinking.level === level)}
          >
            {t(THINKING_LEVEL_KEYS[level] || 'chat.thinking.level.medium')}
          </button>
        ))}
      </div>
      <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('chat.thinkingPanel.display')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(displays || []).map(display => (
          <button
            key={display}
            type="button"
            onClick={() => onApply({ display })}
            style={chip(thinking.display === display)}
          >
            {t(THINKING_DISPLAY_KEYS[display] || 'chat.thinking.display.fold')}
          </button>
        ))}
      </div>
      <div>
        <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
      </div>
    </Modal>
  );
}