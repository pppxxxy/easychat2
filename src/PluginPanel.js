import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, TextField } from './ui';
import { getPlugins, savePlugins } from './storage';
import { useTheme } from './theme/ThemeContext';
import { PROVIDERS } from './plugins/providers';

export default function PluginPanel({ visible, onClose }) {
  const [plugins, setPlugins] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState({});
  const pluginsRef = useRef([]);
  const lastSavedPluginsRef = useRef([]);
  const persistVersionRef = useRef(0);
  const persistQueueRef = useRef(Promise.resolve());
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  useEffect(() => {
    if (!visible) {
      setLoaded(false);
      setShowKey({});
      return undefined;
    }
    let cancelled = false;
    getPlugins()
      .then(list => {
         if (cancelled) return;
         // 存量停服供应商（如 Bing）被规范化换源时带 providerMigrated 标记：
         // 这里给出一次性可见提示并落盘清除标记，避免无痕静默换源。
         const migratedFrom = (Array.isArray(list) ? list : [])
           .filter(plugin => plugin && plugin.type === 'web-search')
           .map(plugin => plugin.config && plugin.config.providerMigrated)
           .find(Boolean);
         const cleaned = (Array.isArray(list) ? list : []).map(plugin => {
           if (plugin && plugin.config && plugin.config.providerMigrated) {
             const { providerMigrated, ...restConfig } = plugin.config;
             return { ...plugin, config: restConfig };
           }
           return plugin;
         });
         pluginsRef.current = cleaned;
         lastSavedPluginsRef.current = cleaned;
         setPlugins(cleaned);
         setLoaded(true);
         if (migratedFrom) {
           Alert.alert(
             '搜索引擎已更新',
             `原先选择的搜索服务（${migratedFrom}）已停服或不可用，已切换为默认服务，请重新检查密钥设置。`
           );
           savePlugins(cleaned).catch(() => {});
         }
      })
      .catch(() => {
        if (!cancelled) Alert.alert('联网搜索读取失败', '请重新打开后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const updatePlugin = useCallback((id, updater) => {
    const current = Array.isArray(pluginsRef.current) ? pluginsRef.current : [];
    const next = current.map(plugin => (plugin.id === id ? updater(plugin) : plugin));
    pluginsRef.current = next;
    setPlugins(next);
    return next;
  }, []);

  const persist = useCallback(list => {
    const version = ++persistVersionRef.current;
    const task = persistQueueRef.current.then(async () => {
      setSaving(true);
      try {
        const saved = await savePlugins(list);
        lastSavedPluginsRef.current = saved;
        if (version === persistVersionRef.current) {
          pluginsRef.current = saved;
          setPlugins(saved);
        }
        return saved;
      } catch (error) {
        if (version === persistVersionRef.current) {
          const fallback = lastSavedPluginsRef.current;
          pluginsRef.current = fallback;
          setPlugins(fallback);
        }
        Alert.alert('保存失败', '请检查存储空间或权限。');
        return null;
      } finally {
        if (version === persistVersionRef.current) setSaving(false);
      }
    });
    persistQueueRef.current = task.catch(() => null);
    return task;
  }, []);

  const togglePlugin = useCallback(async (plugin, value) => {
    if (value && plugin.type === 'web-search') {
      const config = plugin.config || {};
      const provider = PROVIDERS.find(item => item.id === config.provider) || PROVIDERS[0];
      let missing = false;
      if (provider.custom) {
        missing = !String(config.customBaseUrl || '').trim()
          || !String(config.apiKey || '').trim();
      } else if ((provider.secretFields || []).includes('apiKey')) {
        missing = !String(config.apiKey || '').trim();
      }
      if (!missing && (provider.extraFields || []).includes('cx')) {
        missing = !String(config.cx || '').trim();
      }
      if (missing) {
        Alert.alert('请先填写密钥', '开启联网搜索前，请先填写搜索服务的密钥或地址。');
        return;
      }
    }
    const next = updatePlugin(plugin.id, item => ({ ...item, enabled: value }));
    await persist(next);
  }, [persist, updatePlugin]);

  const openKeyUrl = useCallback(async url => {
    if (!url) return;
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('无法打开链接', url);
        return;
      }
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert('无法打开链接', url);
    }
  }, []);

  const setConfigField = useCallback((id, key, value) => {
    updatePlugin(id, plugin => ({
      ...plugin,
      config: { ...(plugin.config || {}), [key]: value },
    }));
  }, [updatePlugin]);

  const onSave = useCallback(() => {
    if (!loaded) return;
    persist(pluginsRef.current);
  }, [loaded, persist]);

  const handleClose = () => {
    if (!loaded) {
      onClose();
      return;
    }
    persist(pluginsRef.current).then(saved => {
      if (saved) onClose();
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>联网搜索</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <FieldHint style={styles.hint}>
              联网搜索为全局能力，开启后对后续请求生效。命中触发词时会获取实时资料并注入对话。
            </FieldHint>
            {loaded ? plugins.map(plugin => {
              const config = plugin.config || {};
              const currentProvider = PROVIDERS.find(
                provider => provider.id === config.provider
              ) || PROVIDERS[0];
              return (
                <View key={plugin.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardText}>
                      <Text style={styles.name}>{plugin.name}</Text>
                      <Text style={styles.desc}>{plugin.description}</Text>
                    </View>
                    <Switch
                      value={plugin.enabled === true}
                      onValueChange={value => togglePlugin(plugin, value)}
                      trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                      thumbColor={theme.colors.primaryContrast}
                    />
                  </View>

                  {plugin.type === 'web-search' ? (
                    <View style={styles.config}>
                      <FieldLabel style={styles.label}>搜索服务</FieldLabel>
                      <View style={styles.providerRow}>
                        {PROVIDERS.map(provider => {
                          const active = config.provider === provider.id;
                          return (
                            <TouchableOpacity
                              key={provider.id}
                              style={[styles.providerChip, active && styles.providerChipActive]}
                              onPress={() => setConfigField(plugin.id, 'provider', provider.id)}
                              activeOpacity={0.8}
                            >
                              <Text style={[styles.providerText, active && styles.providerTextActive]}>
                                {provider.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      <FieldLabel style={styles.label}>API 密钥</FieldLabel>
                      <View style={styles.keyRow}>
                        <TextField
                          style={styles.keyInput}
                          value={config.apiKey || ''}
                          onChangeText={text => setConfigField(plugin.id, 'apiKey', text)}
                          placeholder="填写搜索服务密钥"
                          secureTextEntry={!showKey[plugin.id]}
                          autoCapitalize="none"
                        />
                        <TouchableOpacity
                          style={styles.eyeButton}
                          onPress={() => setShowKey(current => ({
                            ...current,
                            [plugin.id]: !current[plugin.id],
                          }))}
                          hitSlop={8}
                        >
                          <Ionicons
                            name={showKey[plugin.id] ? 'eye-off-outline' : 'eye-outline'}
                            size={18}
                            color={theme.colors.textFaint}
                          />
                        </TouchableOpacity>
                      </View>

                      {(currentProvider.keyLinks || []).length > 0 ? (
                        <View style={styles.keyLinks}>
                          {(currentProvider.keyLinks || []).map(link => (
                            <TouchableOpacity
                              key={link.url}
                              style={styles.keyLink}
                              onPress={() => openKeyUrl(link.url)}
                              activeOpacity={0.8}
                              accessibilityRole="link"
                              accessibilityLabel={link.label}
                            >
                              <Ionicons name="open-outline" size={16} color={theme.colors.primarySoft} />
                              <Text style={styles.keyLinkText}>{link.label}</Text>
                              <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : null}

                      {(currentProvider.extraFields || []).includes('cx') ? (
                        <>
                          <FieldLabel style={styles.label}>搜索引擎 ID（cx）</FieldLabel>
                          <TextField
                            value={config.cx || ''}
                            onChangeText={text => setConfigField(plugin.id, 'cx', text)}
                            placeholder="Google 自定义搜索引擎 ID"
                            autoCapitalize="none"
                          />
                        </>
                      ) : null}

                      {currentProvider.custom ? (
                        <>
                          <FieldLabel style={styles.label}>自定义接口地址</FieldLabel>
                          <TextField
                            value={config.customBaseUrl || ''}
                            onChangeText={text => setConfigField(plugin.id, 'customBaseUrl', text)}
                            placeholder="https://example.com/search"
                            autoCapitalize="none"
                          />
                        </>
                      ) : null}

                      <FieldLabel style={styles.label}>结果条数（1-10）</FieldLabel>
                      <TextField
                        value={String(config.maxResults ?? 5)}
                        onChangeText={text => setConfigField(plugin.id, 'maxResults', text)}
                        keyboardType="number-pad"
                        placeholder="5"
                      />
                    </View>
                  ) : null}
                </View>
              );
            }) : null}

            <TouchableOpacity
              style={[styles.saveButton, saving && styles.disabled]}
              onPress={onSave}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={styles.saveText}>{saving ? '保存中...' : '保存'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    maxHeight: '88%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 16 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  cardText: { flex: 1, marginRight: 8 },
  name: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  desc: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17), marginTop: 3 },
  config: { marginTop: 10 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 10, marginBottom: 6 },
  providerRow: { flexDirection: 'row', flexWrap: 'wrap' },
  providerChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  providerChipActive: { backgroundColor: theme.colors.primaryAlpha(0.25), borderColor: theme.colors.primary },
  providerText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  providerTextActive: { color: theme.colors.primarySoft },
  keyRow: { flexDirection: 'row', alignItems: 'center' },
  keyInput: { flex: 1, minHeight: 40 },
  eyeButton: { paddingHorizontal: 8, paddingVertical: 8 },
  keyLinks: { marginTop: 8 },
  keyLink: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  keyLinkText: { flex: 1, color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 8 },
  saveButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  saveText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
