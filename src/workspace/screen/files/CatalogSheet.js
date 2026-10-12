// 环境与配置下载弹层（「下载中心」）：套餐一键写入 + 单条模板写入 + 自定义 URL 下载。
// 从 screen/FilesPanel.js 原样外提（无行为变化）：纯展示，状态与写入编排仍留在宿主面板。

import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import { FieldHint, FieldLabel, PrimaryButton, SheetHeader, TextField } from '../../../ui/index.js';
import { CATALOG_BUNDLES, CATALOG_CATEGORIES, catalogItemsByCategory } from '../../catalog.js';

export default function CatalogSheet({
  visible,
  styles,
  t,
  onClose,
  bundleBusy,
  catalogBusyId,
  catalogStatuses,
  catalogInputs,
  setCatalogInputs,
  customUrl,
  setCustomUrl,
  customBusy,
  onBundleWrite,
  onCatalogWrite,
  onCustomDownload,
}) {
  if (!visible) return null;
  return (
    <View style={styles.layer}>
      <SheetHeader title={t('workspace.panel.catalog.title')} onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body}>
        <FieldHint>{t('workspace.panel.catalog.hint')}</FieldHint>
        {CATALOG_BUNDLES.map(bundle => {
          const busy = bundleBusy && bundleBusy.id === bundle.id;
          return (
            <View key={bundle.id} style={styles.bundleCard}>
              <View style={styles.catalogItemMain}>
                <Text style={styles.bundleTitle} numberOfLines={1}>{t(bundle.titleKey)}</Text>
                <TouchableOpacity
                  style={[styles.bundleWriteButton, (bundleBusy || catalogBusyId) && styles.actionButtonDisabled]}
                  disabled={!!(bundleBusy || catalogBusyId)}
                  onPress={() => onBundleWrite(bundle.id)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.bundleWriteText}>
                    {busy
                      ? t('workspace.panel.catalog.bundle.progress', { done: bundleBusy.done, total: bundleBusy.total })
                      : t('workspace.panel.catalog.bundle.action')}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.catalogItemDesc}>{t(bundle.descKey)}</Text>
              {bundle.needsGitIdentity && bundle.id === (bundleBusy && bundleBusy.id) ? (
                <Text style={styles.bundleProgressNote}>
                  {t('workspace.panel.catalog.bundle.gitIdentityNote', {
                    name: (catalogInputs.gitconfig && catalogInputs.gitconfig.userName) || '',
                    email: (catalogInputs.gitconfig && catalogInputs.gitconfig.userEmail) || '',
                  })}
                </Text>
              ) : null}
            </View>
          );
        })}
        {CATALOG_CATEGORIES.map(category => {
          const items = catalogItemsByCategory(category);
          if (items.length === 0) return null;
          return (
            <View key={category} style={styles.catalogSection}>
              <FieldLabel>{t(`workspace.panel.catalog.category.${category}`)}</FieldLabel>
              {items.map(item => {
                const inputs = item.inputs || [];
                const busy = catalogBusyId === item.id;
                const status = catalogStatuses[item.id] || 'absent';
                return (
                  <View key={item.id} style={styles.catalogItem}>
                    <View style={styles.catalogItemMain}>
                      <Text style={styles.catalogItemTitle} numberOfLines={1}>{t(item.titleKey)}</Text>
                      <TouchableOpacity
                        style={[styles.catalogWriteButton, busy && styles.actionButtonDisabled]}
                        disabled={!!catalogBusyId}
                        onPress={() => onCatalogWrite(item.id)}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.catalogWriteText}>
                          {t(status === 'absent' ? 'workspace.panel.catalog.write' : 'workspace.panel.catalog.rewrite')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.catalogItemDesc}>{t(item.descKey)}</Text>
                    <View style={styles.catalogItemMeta}>
                      <Text style={styles.catalogItemFile}>{item.file}</Text>
                      {status !== 'absent' ? (
                        <Text style={[styles.catalogStatusBadge, status === 'diff' && styles.catalogStatusBadgeDiff]}>
                          {t(status === 'same' ? 'workspace.panel.catalog.status.same' : 'workspace.panel.catalog.status.diff')}
                        </Text>
                      ) : null}
                    </View>
                    {inputs.length > 0 ? (
                      <View style={styles.catalogInputs}>
                        {inputs.map(input => (
                          <TextField
                            key={input.key}
                            style={styles.input}
                            label={t(input.labelKey)}
                            placeholder={t(input.placeholderKey)}
                            value={(catalogInputs[item.id] && catalogInputs[item.id][input.key]) || ''}
                            onChangeText={value => setCatalogInputs(current => ({
                              ...current,
                              [item.id]: { ...(current[item.id] || {}), [input.key]: value },
                            }))}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        })}

        <View style={styles.catalogSection}>
          <FieldLabel>{t('workspace.panel.catalog.custom.title')}</FieldLabel>
          <TextField
            style={styles.input}
            placeholder={t('workspace.panel.catalog.custom.placeholder')}
            value={customUrl}
            onChangeText={setCustomUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.formActions}>
            <PrimaryButton
              title={customBusy ? t('workspace.panel.catalog.custom.busy') : t('workspace.panel.catalog.custom.action')}
              small
              onPress={onCustomDownload}
            />
          </View>
          <FieldHint>{t('workspace.panel.catalog.custom.hint')}</FieldHint>
        </View>
      </ScrollView>
    </View>
  );
}
