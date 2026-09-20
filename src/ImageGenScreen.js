import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';

import { IMAGE_PROVIDERS, getImageProvider } from './imageGen/providers';
import { generateImage, detectImageProvider } from './imageGen';
import { getImageGenSettings, saveImageGenSettings } from './storage';
import ChapterModal from './ChapterModal';
import { TopicButton } from './ui';
import { useTheme } from './theme/ThemeContext';

const SIZES = ['1024*1024', '1024*1792', '1792*1024', '512*512'];
const DEFAULT_PROVIDER = IMAGE_PROVIDERS[0].id;

function isImageLike(name, mime) {
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(String(name || ''));
}

export default function ImageGenScreen({ embedded = false }) {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState({ activeProvider: DEFAULT_PROVIDER, providers: {} });
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState(SIZES[0]);
  const [seed, setSeed] = useState('');
  const [imageUri, setImageUri] = useState('');
  const [imageMime, setImageMime] = useState('image/png');
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState([]);
  const [busyResult, setBusyResult] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [draftApiKey, setDraftApiKey] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftExtra, setDraftExtra] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [topic, setTopic] = useState(null);
  const mountedRef = useRef(true);
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stored = await getImageGenSettings();
        if (!mountedRef.current) return;
        setSettings(stored.activeProvider ? stored : { ...stored, activeProvider: DEFAULT_PROVIDER });
      } catch (error) {
        if (mountedRef.current) Alert.alert('读取配置失败', '请重新打开应用后重试。');
      } finally {
        if (mountedRef.current) setLoaded(true);
      }
    })();
  }, []);

  const providerId = settings.activeProvider || DEFAULT_PROVIDER;
  const provider = useMemo(() => getImageProvider(providerId), [providerId]);
  const providerConfig = settings.providers[providerId] || {};
  const model = String(providerConfig.model || provider.defaultModel || '').trim();
  const modelList = useMemo(
    () => model
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean),
    [model]
  );

  const persistProvider = useCallback(async (id, patch) => {
    const next = {
      ...settings,
      providers: {
        ...settings.providers,
        [id]: { ...(settings.providers[id] || {}), ...patch },
      },
    };
    setSettings(next);
    try {
      await saveImageGenSettings(next);
    } catch (error) {
      if (mountedRef.current) Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, [settings]);

  const pickProvider = useCallback(async id => {
    setProviderOpen(false);
    const next = { ...settings, activeProvider: id };
    setSettings(next);
    try {
      await saveImageGenSettings(next);
    } catch (error) {
      if (mountedRef.current) Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, [settings]);

  const openSettings = useCallback(() => {
    setDraftBaseUrl(String(providerConfig.baseUrl || provider.baseUrl || ''));
    setDraftApiKey(String(providerConfig.apiKey || ''));
    setDraftModel(String(providerConfig.model || provider.defaultModel || ''));
    setDraftExtra(providerConfig.extra ? JSON.stringify(providerConfig.extra) : '');
    setSettingsOpen(true);
  }, [provider.baseUrl, provider.defaultModel, providerConfig]);

  const detectProvider = useCallback(async () => {
    if (detecting) return;
    setDetecting(true);
    try {
      const result = await detectImageProvider({
        provider,
        config: {
          baseUrl: draftBaseUrl.trim() || provider.baseUrl || '',
          apiKey: draftApiKey.trim(),
          model: draftModel.trim() || provider.defaultModel || '',
        },
        model: draftModel.trim() || provider.defaultModel || '',
        prompt: prompt.trim(),
      });
      if (result.ok) {
        const extra = result.modelFound === false
          ? '\n（模型名可能不正确，但接口已连通）'
          : '';
        Alert.alert('检测成功', `${result.message}${extra}`);
      } else {
        Alert.alert('检测失败', result.error || '无法连接');
      }
    } finally {
      if (mountedRef.current) setDetecting(false);
    }
  }, [detecting, draftApiKey, draftBaseUrl, draftModel, prompt, provider]);

  const openApiKeyUrl = useCallback(async () => {
    if (!provider.apiKeyUrl) {
      Alert.alert('获取 API Key', provider.keyHint || '请从服务提供方后台获取 API Key。');
      return;
    }
    try {
      const canOpen = await Linking.canOpenURL(provider.apiKeyUrl);
      if (!canOpen) {
        Alert.alert('无法打开链接', provider.apiKeyUrl);
        return;
      }
      await Linking.openURL(provider.apiKeyUrl);
    } catch (error) {
      Alert.alert('无法打开链接', provider.apiKeyUrl);
    }
  }, [provider.apiKeyUrl, provider.keyHint]);

  const confirmSettings = useCallback(async () => {
    let extra = {};
    const extraText = draftExtra.trim();
    if (extraText) {
      try {
        const parsed = JSON.parse(extraText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          Alert.alert('额外参数无效', '请输入 JSON 对象，例如 {"quality":"hd"}。');
          return;
        }
        extra = parsed;
      } catch (error) {
        Alert.alert('额外参数无效', '请输入合法的 JSON。');
        return;
      }
    }
    setSettingsOpen(false);
    await persistProvider(providerId, {
      baseUrl: draftBaseUrl.trim(),
      apiKey: draftApiKey.trim(),
      model: draftModel.trim(),
      extra,
    });
  }, [draftApiKey, draftBaseUrl, draftExtra, draftModel, persistProvider, providerId]);

  const pickImage = useCallback(async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets || !picked.assets.length) return;
      const asset = picked.assets[0];
      if (!isImageLike(asset.name, asset.mimeType)) {
        Alert.alert('不支持的文件', '请选择图片文件。');
        return;
      }
      setImageUri(asset.uri);
      setImageMime(asset.mimeType || 'image/png');
    } catch (error) {
      Alert.alert('选择图片失败', '请重试。');
    }
  }, []);

  const clearImage = useCallback(() => {
    setImageUri('');
    setImageMime('image/png');
  }, []);

  const onGenerate = useCallback(async () => {
    if (generating) return;
    const text = prompt.trim();
    if (!text && !imageUri) {
      Alert.alert('请输入提示词', '需要提示词才能生成图片。');
      return;
    }
    if (!String(providerConfig.baseUrl || provider.baseUrl || '').trim()) {
      Alert.alert('请先填写 API 地址', '点击「填密钥」打开设置面板。');
      return;
    }
    if (!String(providerConfig.apiKey || '').trim()) {
      Alert.alert('请先填写 API 密钥', '点击「填密钥」打开设置面板。');
      return;
    }
    if (imageUri && !provider.i2i) {
      Alert.alert('不支持图生图', '当前服务只支持文生图，请移除输入图片。');
      return;
    }
    setGenerating(true);
    try {
      let imageFile = '';
      if (imageUri) {
        const base64 = await FileSystem.readAsStringAsync(imageUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        imageFile = `data:${imageMime || 'image/png'};base64,${base64}`;
      }
      const seedValue = seed.trim() === '' ? undefined : Number(seed.trim());
      const response = await generateImage({
        provider,
        config: providerConfig,
        prompt: text,
        imageFile,
        imageUri: imageUri || undefined,
        imageMime,
        model: model || undefined,
        size,
        seed: Number.isFinite(seedValue) ? seedValue : undefined,
      });
      if (!mountedRef.current) return;
      setResults(current => [...response.images, ...current].slice(0, 30));
    } catch (error) {
      Alert.alert('生成失败', (error && error.message) || '请稍后重试。');
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }, [generating, imageMime, imageUri, model, prompt, provider, providerConfig, seed, size]);

  const saveResult = useCallback(async result => {
    if (busyResult) return;
    setBusyResult(result.url || result.base64 || 'result');
    try {
      let uri = '';
      if (result.base64) {
        const dir = `${FileSystem.cacheDirectory}image-gen/`;
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        uri = `${dir}generated-${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(uri, result.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } else if (result.url) {
        const dir = `${FileSystem.cacheDirectory}image-gen/`;
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        uri = `${dir}generated-${Date.now()}.png`;
        const downloaded = await FileSystem.downloadAsync(result.url, uri);
        uri = downloaded.uri;
      }
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available && uri) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '保存图片' });
      } else if (uri) {
        Alert.alert('已保存', `文件已生成：\n${uri}`);
      } else {
        Alert.alert('无法保存', '该结果没有可保存的内容。');
      }
    } catch (error) {
      Alert.alert('保存失败', '请稍后重试。');
    } finally {
      if (mountedRef.current) setBusyResult('');
    }
  }, [busyResult]);

  const copyResult = useCallback(async result => {
    const value = result.url || result.base64 || '';
    if (!value) return;
    try {
      await Clipboard.setStringAsync(value);
      Alert.alert('已复制', result.url ? '图片链接已复制。' : '图片数据已复制。');
    } catch (error) {
      Alert.alert('复制失败', '请重试。');
    }
  }, []);

  const onPressResult = useCallback(result => {
    Alert.alert('图片操作', '请选择要执行的操作。', [
      { text: '取消', style: 'cancel' },
      { text: '保存 / 分享', onPress: () => saveResult(result) },
      { text: '复制', onPress: () => copyResult(result) },
    ]);
  }, [copyResult, saveResult]);

  const imagePreview = useMemo(() => (imageUri ? { uri: imageUri } : null), [imageUri]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, embedded && styles.containerEmbedded]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, embedded && styles.headerEmbedded]}>
        {embedded ? null : <Text style={styles.title}>生图</Text>}
        <View style={styles.headerActions}>
          <TopicButton
            style={styles.topicButton}
            onPress={() => setTopic('image-api')}
            accessibilityLabel="查看生图教学"
          />
          <TouchableOpacity style={styles.keyButton} onPress={openSettings} activeOpacity={0.8}>
            <Ionicons name="key-outline" size={16} color={theme.colors.primaryContrast} />
            <Text style={styles.keyButtonText}>填密钥</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>服务</Text>
        <TouchableOpacity style={styles.selectButton} onPress={() => setProviderOpen(true)} activeOpacity={0.8}>
          <Text style={styles.selectButtonText}>{provider.label}</Text>
          <Ionicons name="chevron-down" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>
        {provider.networkNote ? (
          <View style={styles.networkNoteRow}>
            <Ionicons name="globe-outline" size={14} color={theme.colors.textMuted} />
            <Text style={styles.networkNoteText}>{provider.networkNote}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>模型</Text>
        <TouchableOpacity
          style={styles.selectButton}
          onPress={() => {
            if (!modelList.length) {
              Alert.alert('未填写模型', '请先点击「填密钥」填写模型名。');
              return;
            }
            setModelOpen(true);
          }}
          activeOpacity={0.8}
        >
          <Text style={[styles.selectButtonText, !model && styles.placeholderText]}>
            {model || '未填写（点击「填密钥」）'}
          </Text>
          <Ionicons name="chevron-down" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>

        <Text style={styles.label}>提示词</Text>
        <TextInput
          style={[styles.input, styles.promptInput]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="描述你想生成的画面..."
          placeholderTextColor={theme.colors.textFaint}
          multiline
          textAlignVertical="top"
        />

        <Text style={styles.label}>尺寸</Text>
        <View style={styles.chipRow}>
          {SIZES.map(item => {
            const active = item === size;
            return (
              <TouchableOpacity
                key={item}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setSize(item)}
                activeOpacity={0.8}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{item}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.label}>随机种子（可选）</Text>
        <TextInput
          style={styles.input}
          value={seed}
          onChangeText={value => setSeed(value.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder="留空为随机"
          placeholderTextColor={theme.colors.textFaint}
        />

        <Text style={styles.label}>输入图片（图生图，可选）</Text>
        {imagePreview ? (
          <View style={styles.previewRow}>
            <Image source={imagePreview} style={styles.preview} resizeMode="cover" />
            <TouchableOpacity style={styles.removeImage} onPress={clearImage} hitSlop={8}>
              <Ionicons name="close" size={16} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.uploadButton} onPress={pickImage} activeOpacity={0.8}>
            <Ionicons name="image-outline" size={18} color={theme.colors.textMuted} />
            <Text style={styles.uploadButtonText}>选择图片</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.generateButton, generating && styles.generateButtonDisabled]}
          onPress={onGenerate}
          disabled={generating}
          activeOpacity={0.8}
        >
          {generating ? (
            <ActivityIndicator color={theme.colors.primaryContrast} />
          ) : (
            <>
              <Ionicons name="sparkles" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.generateButtonText}>生成</Text>
            </>
          )}
        </TouchableOpacity>
        {generating ? <Text style={styles.generatingHint}>生成中，请稍候...</Text> : null}

        {results.length > 0 ? (
          <>
            <Text style={styles.label}>结果画廊</Text>
            <View style={styles.gallery}>
              {results.map((result, index) => {
                const uri = result.url || (result.base64 ? `data:image/png;base64,${result.base64}` : '');
                const key = result.url || `${index}-${result.base64 ? result.base64.slice(0, 16) : ''}`;
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.galleryItem}
                    onPress={() => onPressResult(result)}
                    activeOpacity={0.85}
                  >
                    {uri ? <Image source={{ uri }} style={styles.galleryImage} resizeMode="cover" /> : null}
                    {busyResult === (result.url || result.base64 || 'result') ? (
                      <View style={styles.galleryBusy}>
                        <ActivityIndicator color={theme.colors.primaryContrast} />
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal visible={providerOpen} transparent animationType="fade" onRequestClose={() => setProviderOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setProviderOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>选择服务</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {IMAGE_PROVIDERS.map(item => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.modalRow}
                  onPress={() => pickProvider(item.id)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.modalRowText, item.id === providerId && styles.modalRowTextActive]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modelOpen} transparent animationType="fade" onRequestClose={() => setModelOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setModelOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>选择模型</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {modelList.map(item => (
                <TouchableOpacity
                  key={item}
                  style={styles.modalRow}
                  onPress={() => {
                    setModelOpen(false);
                    persistProvider(providerId, { model: item });
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.modalRowText, item === model && styles.modalRowTextActive]}>{item}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{provider.label} 设置</Text>
            <Text style={styles.hint}>密钥仅保存在本机，不会写入日志或文档。</Text>
            {provider.keyHint ? (
              <Text style={styles.hint}>密钥：{provider.keyHint}</Text>
            ) : null}
            {provider.corsNote ? (
              <Text style={styles.hint}>
                CORS：{provider.corsNote}
              </Text>
            ) : null}
            <Text style={styles.label}>API 地址</Text>
            <TextInput
              style={styles.input}
              value={draftBaseUrl}
              onChangeText={setDraftBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider.baseUrlPlaceholder || provider.baseUrl || 'https://example.com/v1/images'}
              placeholderTextColor={theme.colors.textFaint}
            />
            <Text style={styles.label}>API Key</Text>
            <TextInput
              style={styles.input}
              value={draftApiKey}
              onChangeText={setDraftApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="sk-..."
              placeholderTextColor={theme.colors.textFaint}
            />
            <TouchableOpacity
              style={[styles.selectButton, styles.apiKeyButton]}
              onPress={openApiKeyUrl}
              activeOpacity={0.8}
            >
              <Ionicons name="open-outline" size={16} color={theme.colors.textMuted} />
              <Text style={styles.selectButtonText}>获取 API Key</Text>
            </TouchableOpacity>
            <Text style={styles.label}>模型名（可用逗号或换行分隔多个）</Text>
            <TextInput
              style={styles.input}
              value={draftModel}
              onChangeText={setDraftModel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider.defaultModel || '模型名'}
              placeholderTextColor={theme.colors.textFaint}
            />
            <TouchableOpacity
              style={[styles.selectButton, styles.detectButton, detecting && styles.generateButtonDisabled]}
              onPress={detectProvider}
              disabled={detecting}
              activeOpacity={0.8}
            >
              <Ionicons name="pulse-outline" size={16} color={theme.colors.textMuted} />
              <Text style={styles.selectButtonText}>{detecting ? '检测中...' : '检测连通性'}</Text>
            </TouchableOpacity>
            <Text style={styles.label}>额外参数（JSON，可选）</Text>
            <TextInput
              style={[styles.input, styles.extraInput]}
              value={draftExtra}
              onChangeText={setDraftExtra}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              placeholder='{"quality":"hd"}'
              placeholderTextColor={theme.colors.textFaint}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setSettingsOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.selectButton} onPress={confirmSettings} activeOpacity={0.8}>
                <Text style={styles.selectButtonText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  containerEmbedded: { paddingTop: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerEmbedded: { justifyContent: 'flex-end', paddingTop: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  title: { color: theme.colors.text, fontSize: fonts.scaled(22), fontWeight: '800' },
  topicButton: {
    marginRight: 8,
  },
  keyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 6 },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 40 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 16, marginBottom: 8 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6 },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptInput: { minHeight: 96 },
  extraInput: { minHeight: 72 },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectButtonGhost: { backgroundColor: theme.colors.surface, flex: 1, justifyContent: 'center', marginRight: 10 },
  detectButton: {
    justifyContent: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  apiKeyButton: {
    justifyContent: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    gap: 6,
  },
  networkNoteRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 8, paddingHorizontal: 2 },
  networkNoteText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginLeft: 6,
    flex: 1,
    lineHeight: fonts.scaled(17),
  },
  selectButtonText: { color: theme.colors.text, fontSize: fonts.scaled(14) },
  placeholderText: { color: theme.colors.textFaint },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    backgroundColor: theme.colors.surface,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  chipTextActive: { color: theme.colors.primaryContrast, fontWeight: '700' },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: 18,
  },
  uploadButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 8 },
  previewRow: { alignSelf: 'flex-start' },
  preview: { width: 120, height: 120, borderRadius: 10, backgroundColor: theme.colors.surface },
  removeImage: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: theme.colors.danger,
    borderRadius: 11,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 24,
  },
  generateButtonDisabled: { opacity: 0.7 },
  generateButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 6 },
  generatingHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), textAlign: 'center', marginTop: 10 },
  gallery: { flexDirection: 'row', flexWrap: 'wrap' },
  galleryItem: {
    width: '48%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    marginRight: '4%',
    marginBottom: 10,
  },
  galleryImage: { width: '100%', height: '100%' },
  galleryBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 32,
  },
  modalTitle: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800', marginBottom: 8 },
  modalList: { maxHeight: 280 },
  modalRow: { paddingVertical: 12 },
  modalRowText: { color: theme.colors.textMuted, fontSize: fonts.scaled(15) },
  modalRowTextActive: { color: theme.colors.primaryMuted, fontWeight: '700' },
  modalActions: { flexDirection: 'row', marginTop: 20 },
});
