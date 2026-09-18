import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getPlugins, savePlugins } from './storage';
import { useTheme } from './theme/ThemeContext';
import { PROVIDERS } from './plugins/providers';

export default function PluginPanel({ visible, onClose }) {
  const [plugins, setPlugins] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState({});
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    getPlugins()
      .then(list => {
        if (cancelled) return;
        setPlugins(list);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) Alert.alert('插件读取失败', '请重新打开后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const updatePlugin = useCallback((id, updater) => {
    setPlugins(current =>
      current.map(plugin => (plugin.id === id ? updater(plugin) : plugin))
    );
  }, []);

  const persist = useCallback(async list => {
    setSaving(true);
    try {
      const saved = await savePlugins(list);
      setPlugins(saved);
      return saved;
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const togglePlugin = useCallback(async (plugin, value) => {
    if (value && plugin.type === 'web-search') {
      const config = plugin.config || {};
      const provider = PROVIDERS.find(item => item.id === config.provider) || PROVIDERS[0];
      let missing = false;
      if (provider.custom) {
        missing = !String(config.customBaseUrl || '').trim();
      } else if ((provider.secretFields || []).includes('apiKey')) {
        missing = !String(config.apiKey || '').trim();
      }
      if (!missing && (provider.extraFields || []).includes('cx')) {
        missing = !String(config.cx || '').trim();
      }
      if (missing) {
        Alert.alert('请先填写密钥', '开启联网搜索前，请先填写搜索服务的密钥或地址。');
      }
    }
    updatePlugin(plugin.id, item => ({ ...item, enabled: value }));
    await persist(plugins.map(item => (item.id === plugin.id ? { ...item, enabled: value } : item)));
  }, [plugins, persist, updatePlugin]);

  const setConfigField = useCallback((id, key, value) => {
    updatePlugin(id, plugin => ({
      ...plugin,
      config: { ...(plugin.config || {}), [key]: value },
    }));
  }, [updatePlugin]);

  const onSave = useCallback(() => {
    persist(plugins);
  }, [plugins, persist]);

  const handleClose = () => {
    persist(plugins).then(saved => {
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
            <Text style={styles.title}>插件</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <Text style={styles.hint}>
              插件为全局能力，开启后对后续请求生效。联网搜索会在消息命中触发词时获取实时资料。
            </Text>
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
                      <Text style={styles.label}>搜索服务</Text>
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

                      <Text style={styles.label}>API 密钥</Text>
                      <View style={styles.keyRow}>
                        <TextInput
                          style={[styles.input, styles.keyInput]}
                          value={config.apiKey || ''}
                          onChangeText={text => setConfigField(plugin.id, 'apiKey', text)}
                          placeholder="填写搜索服务密钥"
                          placeholderTextColor={theme.colors.textFaint}
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

                      {(currentProvider.extraFields || []).includes('cx') ? (
                        <>
                          <Text style={styles.label}>搜索引擎 ID（cx）</Text>
                          <TextInput
                            style={styles.input}
                            value={config.cx || ''}
                            onChangeText={text => setConfigField(plugin.id, 'cx', text)}
                            placeholder="Google 自定义搜索引擎 ID"
                            placeholderTextColor={theme.colors.textFaint}
                            autoCapitalize="none"
                          />
                        </>
                      ) : null}

                      {currentProvider.custom ? (
                        <>
                          <Text style={styles.label}>自定义接口地址</Text>
                          <TextInput
                            style={styles.input}
                            value={config.customBaseUrl || ''}
                            onChangeText={text => setConfigField(plugin.id, 'customBaseUrl', text)}
                            placeholder="https://example.com/search"
                            placeholderTextColor={theme.colors.textFaint}
                            autoCapitalize="none"
                          />
                        </>
                      ) : null}

                      <Text style={styles.label}>结果条数（1-10）</Text>
                      <TextInput
                        style={styles.input}
                        value={String(config.maxResults ?? 5)}
                        onChangeText={text => setConfigField(plugin.id, 'maxResults', text)}
                        keyboardType="number-pad"
                        placeholder="5"
                        placeholderTextColor={theme.colors.textFaint}
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
  providerChipActive: { backgroundColor: `${theme.colors.primary}40`, borderColor: theme.colors.primary },
  providerText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  providerTextActive: { color: theme.colors.primarySoft },
  keyRow: { flexDirection: 'row', alignItems: 'center' },
  keyInput: { flex: 1 },
  eyeButton: { paddingHorizontal: 8, paddingVertical: 8 },
  input: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
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
