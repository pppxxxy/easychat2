// API 配置卡：多套配置（新建/切换/删除）、协议与鉴权、模型列表、能力位、检测模型。
//
// 数据与编排见 useApiConfigs.js；本文件只做表单。字段集合与 Android 设置页保持一致
// （协议、提示缓存 TTL、鉴权头/前缀、降级模型），避免两边保存的配置互相"丢字段"。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import {
  Button,
  Card,
  Divider,
  Field,
  Row,
  SecretInput,
  Select,
  TextInput,
  Toggle,
} from './ui.jsx';

const PROMPT_CACHE_OPTIONS = ['off', '5m', '1h'];
const THINKING_FORMATS = ['effort', 'boolean', 'object'];

function ModelRow({ model, config, isActiveModel, palette, fonts, onActivate, onRemove, onPatchCapability, t }) {
  const [expanded, setExpanded] = useState(false);
  const caps = (config.modelCapabilities && config.modelCapabilities[model]) || {};
  return (
    <div style={{
      border: `1px solid ${isActiveModel ? palette.primaryMuted : palette.divider}`,
      borderRadius: 8,
      padding: '8px 10px',
      background: isActiveModel ? palette.surfaceAlt : 'transparent',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => onActivate(model)}
          title={t('settings.api.modelListHint')}
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            color: palette.text,
            cursor: 'pointer',
            fontSize: fonts.scaled(12),
            fontWeight: isActiveModel ? 700 : 500,
            padding: 0,
          }}
        >
          {model}{isActiveModel ? ` · ${t('settings.api.current')}` : ''}
        </button>
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          title={t('settings.api.a11yConfigureCapability', { model })}
          style={{
            background: 'transparent',
            border: `1px solid ${palette.divider}`,
            borderRadius: 6,
            color: palette.textMuted,
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 8px',
          }}
        >
          {t('settings.capability.title')}
        </button>
        <button
          type="button"
          onClick={() => onRemove(model)}
          title={t('common.delete')}
          style={{
            background: 'transparent',
            border: 'none',
            color: palette.textFaint,
            cursor: 'pointer',
            fontSize: 15,
            padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>
      {expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('settings.capability.hint')}</div>
          <Toggle
            checked={caps.supportsThinking === true}
            onChange={value => onPatchCapability(model, { supportsThinking: value })}
            label={t('settings.capability.thinking')}
            palette={palette}
            fonts={fonts}
          />
          {caps.supportsThinking === true ? (
            <Row>
              <Select
                value={caps.thinkingField || 'reasoning_effort'}
                options={['reasoning_effort', 'thinking', 'enable_thinking'].map(field => ({ value: field, label: field }))}
                onChange={value => onPatchCapability(model, { thinkingField: value })}
                palette={palette}
                fonts={fonts}
              />
              <Select
                value={caps.thinkingFormat || 'effort'}
                options={THINKING_FORMATS.map(format => ({ value: format, label: format }))}
                onChange={value => onPatchCapability(model, { thinkingFormat: value })}
                palette={palette}
                fonts={fonts}
              />
            </Row>
          ) : null}
          <Toggle
            checked={caps.supportsVision === true}
            onChange={value => onPatchCapability(model, { supportsVision: value })}
            label={t('settings.capability.vision')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={caps.supportsVideo === true}
            onChange={value => onPatchCapability(model, { supportsVideo: value })}
            label={t('settings.capability.video')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={caps.supportsAudio === true}
            onChange={value => onPatchCapability(model, { supportsAudio: value })}
            label={t('settings.capability.audio')}
            palette={palette}
            fonts={fonts}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function ApiCard({ api, palette, fonts }) {
  const { t } = useTranslation();
  const [modelDraft, setModelDraft] = useState('');
  const [vendorOpen, setVendorOpen] = useState(false);
  const active = api.active;

  const openKeyUrl = () => {
    if (!active || !active.apiKeyUrl) return;
    getBridge().app.openExternal(active.apiKeyUrl).catch(() => {
      Alert.alert(t('settings.api.openLinkFailed'), active.apiKeyUrl);
    });
  };

  if (!api.loaded) {
    return <Card title={t('settings.api.title')} palette={palette} fonts={fonts}>{t('backup.progress.ratio')}</Card>;
  }

  return (
    <Card
      title={t('settings.api.title')}
      hint={t('settings.api.keyHint')}
      palette={palette}
      fonts={fonts}
    >
      <Row>
        <Select
          value={api.activeId}
          options={api.configs.map(item => ({
            value: item.id,
            label: `${item.name}${item.id === api.activeId ? ` · ${t('settings.api.current')}` : ''}`,
          }))}
          onChange={api.selectConfig}
          palette={palette}
          fonts={fonts}
          disabled={api.busy}
        />
        <Button label={t('settings.api.add')} onClick={() => setVendorOpen(value => !value)} palette={palette} fonts={fonts} disabled={api.busy} />
        <Button label={t('settings.api.deleteCurrent')} onClick={api.deleteConfig} palette={palette} fonts={fonts} disabled={api.busy || api.configs.length <= 1} />
      </Row>

      {vendorOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', border: `1px dashed ${palette.divider}`, borderRadius: 8 }}>
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('settings.api.emptyHint')}</div>
          {api.vendors.map(vendor => (
            <button
              key={vendor.id}
              type="button"
              onClick={() => {
                setVendorOpen(false);
                api.addConfig(vendor);
              }}
              style={{
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                color: palette.text,
                cursor: 'pointer',
                fontSize: fonts.scaled(12),
                padding: '4px 2px',
              }}
            >
              {t(vendor.nameKey)}
              <span style={{ color: palette.textFaint }}> · {t(vendor.noteKey)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Divider palette={palette} />

      {active ? (
        <>
          <Field label={t('settings.api.name')} palette={palette} fonts={fonts}>
            <TextInput
              value={active.name}
              onChange={value => api.updateField({ name: value })}
              placeholder={t('settings.api.namePlaceholder')}
              palette={palette}
              fonts={fonts}
            />
          </Field>
          <Field label={t('settings.api.baseUrl')} hint={t('settings.api.baseUrlHint')} palette={palette} fonts={fonts}>
            <TextInput
              value={active.baseUrl}
              onChange={value => api.updateField({ baseUrl: value })}
              placeholder="https://api.deepseek.com"
              palette={palette}
              fonts={fonts}
            />
          </Field>
          <Field label={t('settings.api.protocol')} hint={t('settings.api.modelListHint')} palette={palette} fonts={fonts}>
            <Select
              value={active.protocol}
              options={api.protocolOptions.map(option => ({ value: option.id, label: option.label }))}
              onChange={api.changeProtocol}
              palette={palette}
              fonts={fonts}
            />
          </Field>
          {active.protocol === 'anthropic' ? (
            <Field label={t('settings.api.promptCache')} hint={t('settings.api.promptCacheHint')} palette={palette} fonts={fonts}>
              <Select
                value={active.promptCacheTtl || 'off'}
                options={PROMPT_CACHE_OPTIONS.map(value => ({ value, label: t(`settings.api.promptCache.${value}`) }))}
                onChange={value => api.updateField({ promptCacheTtl: value })}
                palette={palette}
                fonts={fonts}
              />
            </Field>
          ) : null}
          <Field label="API Key" palette={palette} fonts={fonts}>
            <SecretInput
              value={active.apiKey}
              onChange={value => api.updateField({ apiKey: value })}
              placeholder="sk-..."
              palette={palette}
              fonts={fonts}
            />
          </Field>
          {active.apiKeyUrl ? (
            <button
              type="button"
              onClick={openKeyUrl}
              style={{ textAlign: 'left', background: 'transparent', border: 'none', color: palette.primaryMuted, cursor: 'pointer', fontSize: fonts.scaled(11), padding: 0 }}
            >
              {t('settings.api.getKey')}
            </button>
          ) : null}
          <Row>
            <Field label="authHeader" palette={palette} fonts={fonts}>
              <TextInput value={active.authHeader} onChange={value => api.updateField({ authHeader: value })} palette={palette} fonts={fonts} />
            </Field>
            <Field label="authScheme" palette={palette} fonts={fonts}>
              <TextInput value={active.authScheme} onChange={value => api.updateField({ authScheme: value })} palette={palette} fonts={fonts} />
            </Field>
          </Row>
          <Field label={t('settings.api.fallbackModels')} hint={t('settings.api.fallbackModelsHint')} palette={palette} fonts={fonts}>
            <TextInput
              value={(active.fallbackModels || []).join(', ')}
              onChange={value => api.updateField({ fallbackModels: value.split(/[,，;\s]+/).filter(Boolean) })}
              placeholder={t('settings.api.fallbackModelsPlaceholder')}
              palette={palette}
              fonts={fonts}
            />
          </Field>

          <Divider palette={palette} />

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ fontSize: fonts.scaled(12), color: palette.text }}>{t('settings.api.modelList')}</strong>
            <Row>
              <Button label={api.detecting ? t('backup.progress.ratio') : t('settings.api.detectModels')} onClick={api.detect} palette={palette} fonts={fonts} disabled={api.detecting} />
            </Row>
          </div>
          <Row>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextInput
                value={modelDraft}
                onChange={setModelDraft}
                placeholder={t('settings.api.modelPlaceholder')}
                palette={palette}
                fonts={fonts}
              />
            </div>
            <Button
              label={t('settings.api.addModel')}
              onClick={() => {
                api.addModel(modelDraft);
                setModelDraft('');
              }}
              palette={palette}
              fonts={fonts}
            />
          </Row>
          {api.modelError ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{api.modelError}</div>
          ) : null}
          {active.models.length === 0 ? (
            <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{t('settings.api.emptyHint')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {active.models.map(model => (
                <ModelRow
                  key={model}
                  model={model}
                  config={active}
                  isActiveModel={api.activeModel === model}
                  palette={palette}
                  fonts={fonts}
                  onActivate={api.setActiveModel}
                  onRemove={api.removeModel}
                  onPatchCapability={api.patchCapability}
                  t={t}
                />
              ))}
            </div>
          )}

          <Row>
            <Button
              label={api.busy ? t('backup.progress.ratio') : t('settings.api.save')}
              onClick={api.save}
              palette={palette}
              fonts={fonts}
              primary
              disabled={api.busy}
            />
            {api.dirty ? (
              <span style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{t('settings.api.dirty.title')}</span>
            ) : null}
          </Row>
        </>
      ) : null}
    </Card>
  );
}