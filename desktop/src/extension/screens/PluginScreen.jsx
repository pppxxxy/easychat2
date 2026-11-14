// 插件（桌面）：内置「联网搜索」的开关与供应商配置。
//
// 这一项此前被标成「不可移植（Android 原生桥接 + JS 沙箱）」——**指错了对象**。
// src/plugins/ 里是 webSearch / webFetch / providers / registry，全是纯 HTTP，
// 走 vendorHttp → XMLHttpRequest（桌面已由主进程代发）。而且共享层的
// chat/useChatSend 本身就在调 runPlugins（getEnabledPlugins → runPlugins），
// 也就是说**搜索链路在桌面早就通了**，缺的只是让用户配它的界面。
//
// 桌面确实没有的是「插件运行时」（从外部加载第三方 JS 并注入界面注入点），
// 那是 Android webview 沙箱才有的能力；本页不做那件，只做内置插件的配置。
//
// 存储复用 storage/settings/plugins 的 getPlugins / savePlugins：读坏时先备份再返回
// 默认值且不落盘（不会把用户填过的密钥冲掉），写回时也会补回缺失的内置项。
// 词条全部复用手机 PluginPanel 的同一批 key，不新造措辞。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { PROVIDERS, getProvider, missingRequiredFields } from '../../../../src/plugins/providers.js';
import { getPlugins, savePlugins } from '../../../../src/storage/settings/plugins.js';
import { Alert } from '../../platform/alert.js';
import { getBridge } from '../../platform/bridge.js';
import { Button, Card, Field, Row, Select, TextInput, Toggle } from '../../settings/ui.jsx';

const SEARCH_PLUGIN_ID = 'web-search';

export default function PluginScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [plugin, setPlugin] = useState(null);
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const list = await getPlugins();
      const found = (Array.isArray(list) ? list : []).find(item => item && item.id === SEARCH_PLUGIN_ID);
      setPlugin(found || null);
      setStatus(found ? 'ok' : 'missing');
    } catch (error) {
      // 读失败不显示「未配置」——那会让用户以为配置丢了，进而覆盖。
      setStatus('corrupt');
      setPlugin(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 写回整表：savePlugins 会补回缺失的内置项，所以只替换本条是安全的。
  const persist = async patch => {
    if (!plugin || busy) return;
    setBusy(true);
    const next = { ...plugin, ...patch, config: { ...(plugin.config || {}), ...(patch.config || {}) } };
    try {
      const list = await getPlugins();
      const merged = (Array.isArray(list) ? list : []).map(item => (item && item.id === SEARCH_PLUGIN_ID ? next : item));
      await savePlugins(merged);
      setPlugin(next);
    } catch (error) {
      Alert.alert(t('plugin.alert.saveFailed.title'), t('plugin.alert.saveFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  // 开启前先校验必填：手机端同一纪律（缺 key 就提示，而不是让搜索静默失败）。
  const toggleEnabled = async value => {
    if (value) {
      const config = (plugin && plugin.config) || {};
      const provider = getProvider(String(config.provider || ''));
      if (missingRequiredFields(provider, config).length > 0) {
        Alert.alert(t('plugin.alert.keyRequired.title'), t('plugin.alert.keyRequired.body'));
        return;
      }
    }
    await persist({ enabled: value });
  };

  const config = (plugin && plugin.config) || {};
  const provider = getProvider(String(config.provider || ''));
  const providerOptions = PROVIDERS.map(item => ({ value: item.id, label: t(item.labelKey) }));
  const needsKey = (provider.secretFields || []).includes('apiKey');
  const needsCx = (provider.extraFields || []).includes('cx');
  const keyLinks = Array.isArray(provider.keyLinks) ? provider.keyLinks : [];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card
        title={t('plugin.title')}
        hint={t('plugin.hint.global')}
        palette={palette}
        fonts={fonts}
      >
        {status === 'loading' ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : null}

        {status === 'corrupt' ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.7 }}>
            {t('plugin.alert.loadFailed.body')}
          </div>
        ) : null}

        {status === 'ok' ? (
          <>
            <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{t('plugin.webSearch.name')}</div>
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
              {t('plugin.webSearch.desc')}
            </div>

            <Row>
              <Toggle
                checked={plugin.enabled === true}
                onChange={toggleEnabled}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Row>

            <Field label={t('plugin.providerLabel')} palette={palette} fonts={fonts}>
              <Select
                value={String(config.provider || PROVIDERS[0].id)}
                options={providerOptions}
                // 换供应商时把不兼容的字段清掉：cx 只对 google-cse 有意义，
                // 留着会让 next 的校验按旧 provider 误判。
                onChange={value => persist({
                  config: { provider: value, cx: value === 'google-cse' ? config.cx || '' : '' },
                })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Field>

            {provider.noteKey ? (
              <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
                {t(provider.noteKey)}
              </div>
            ) : null}

            {needsKey ? (
              <Field label={t('plugin.apiKeyLabel')} palette={palette} fonts={fonts}>
                <TextInput
                  value={String(config.apiKey || '')}
                  onChange={value => persist({ config: { apiKey: value } })}
                  placeholder={t('plugin.apiKeyPlaceholder')}
                  palette={palette}
                  fonts={fonts}
                  type="password"
                />
              </Field>
            ) : null}

            {needsCx ? (
              <Field label={t('plugin.cxLabel')} palette={palette} fonts={fonts}>
                <TextInput
                  value={String(config.cx || '')}
                  onChange={value => persist({ config: { cx: value } })}
                  placeholder={t('plugin.cxPlaceholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </Field>
            ) : null}

            {provider.custom ? (
              <Field label={t('plugin.customUrlLabel')} palette={palette} fonts={fonts}>
                <TextInput
                  value={String(config.customBaseUrl || '')}
                  onChange={value => persist({ config: { customBaseUrl: value } })}
                  palette={palette}
                  fonts={fonts}
                />
              </Field>
            ) : null}

            <Field label={t('plugin.maxResultsLabel')} palette={palette} fonts={fonts}>
              <TextInput
                value={String(config.maxResults === undefined ? '' : config.maxResults)}
                onChange={value => persist({ config: { maxResults: value } })}
                palette={palette}
                fonts={fonts}
              />
            </Field>

            {/* 取密钥的链接：手机端用 Linking.openURL，桌面交给系统浏览器（只放行外部 scheme）。 */}
            {keyLinks.length > 0 ? (
              <Row>
                {keyLinks.map(link => (
                  <Button
                    key={link.url}
                    label={t(link.labelKey)}
                    onClick={() => {
                      getBridge().app.openExternal(link.url).catch(() => {
                        Alert.alert(t('plugin.alert.openLinkFailed.title'), link.url);
                      });
                    }}
                    palette={palette}
                    fonts={fonts}
                  />
                ))}
              </Row>
            ) : null}

            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
              {t('plugin.hint.privacy')}
            </div>
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
              {t('desktop.plugins.hint')}
            </div>
          </>
        ) : null}
      </Card>
    </div>
  );
}