import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';

import { IMAGE_PROVIDERS, getImageProvider } from './imageGen/providers';
import { generateImage, detectImageProvider, probeImageProvider } from './imageGen';
import { getImageGenSettings, saveImageGenSettings } from './storage';
import { resolveImageFormat } from './imageResultFormat';
import ChapterModal from './ChapterModal';
import { Chip, FieldHint, FieldLabel, PrimaryButton, TextField, TopicButton } from './ui';
import { useTheme } from './theme/ThemeContext';
import { maskSecrets } from './secrets';

const SIZES = ['1024*1024', '1024*1792', '1792*1024', '512*512'];
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_PIXELS = 20000000;
const DEFAULT_PROVIDER = IMAGE_PROVIDERS[0].id;

// 结果身份标识：以前直接把整串 base64 存进 state 做比较，
// 每次渲染都要比对 MB 级字符串；这里改成一个短标识。
function resultToken(result) {
  if (!result) return '';
  if (result.id) return `id:${result.id}`;
  if (result.url) return `url:${result.url}`;
  const base64 = String(result.base64 || '');
  if (!base64) return 'result';
  return `b64:${base64.length}:${base64.slice(0, 16)}`;
}

export function normalizeModelList(value, fallback = '') {
  const source = String(value || fallback || '');
  return [...new Set(source.split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}

function isImageLike(name, mime) {
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(String(name || ''));
}

function getImageDimensions(uri) {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export default function ImageGenScreen({ embedded = false, active = true }) {
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
  const generationControllerRef = useRef(null);
  const detectionControllerRef = useRef(null);
  const settingsRef = useRef(settings);
  const settingsSaveQueueRef = useRef(Promise.resolve());
  const settingsRevisionRef = useRef(0);
  const lastSavedSettingsRef = useRef(settings);
  settingsRef.current = settings;
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  useEffect(() => {
    mountedRef.current = true;
     return () => {
       mountedRef.current = false;
       generationControllerRef.current?.abort();
       generationControllerRef.current = null;
       detectionControllerRef.current?.abort();
       detectionControllerRef.current = null;
     };

  }, []);

  useEffect(() => {
    if (active) return;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    detectionControllerRef.current?.abort();
    detectionControllerRef.current = null;
    if (mountedRef.current) {
      setGenerating(false);
      setDetecting(false);
    }
  }, [active]);

  useEffect(() => {
    (async () => {
      try {
        const stored = await getImageGenSettings();
        if (!mountedRef.current) return;
        const normalized = stored.activeProvider ? stored : { ...stored, activeProvider: DEFAULT_PROVIDER };
        lastSavedSettingsRef.current = normalized;
        setSettings(normalized);
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
  const modelList = useMemo(
    () => normalizeModelList(providerConfig.model, provider.defaultModel),
    [provider.defaultModel, providerConfig.model]
  );
  const model = modelList[0] || '';

  const persistSettings = useCallback(next => {
    if (!loaded) return Promise.resolve(false);
    const version = ++settingsRevisionRef.current;
    settingsRef.current = next;
    setSettings(next);
    const task = settingsSaveQueueRef.current.then(async () => {
      try {
        await saveImageGenSettings(next);
        lastSavedSettingsRef.current = next;
        return true;
      } catch (error) {
        if (version === settingsRevisionRef.current) {
          settingsRef.current = lastSavedSettingsRef.current;
          setSettings(lastSavedSettingsRef.current);
        }
        if (mountedRef.current) Alert.alert('保存失败', '请检查存储空间或权限。');
        return false;
      }
    });
    settingsSaveQueueRef.current = task.catch(() => false);
    return task;
  }, [loaded]);

  const persistProvider = useCallback((id, patch) => {
    if (!loaded) return Promise.resolve(false);
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    const base = settingsRef.current;
    const next = {
      ...base,
      providers: {
        ...base.providers,
        [id]: { ...(base.providers[id] || {}), ...patch },
      },
    };
    return persistSettings(next);
  }, [loaded, persistSettings]);

  const pickProvider = useCallback(id => {
    if (!loaded) return Promise.resolve(false);
    setProviderOpen(false);
    return persistSettings({ ...settingsRef.current, activeProvider: id });
  }, [loaded, persistSettings]);

  const openSettings = useCallback(() => {
    if (!loaded) return;
    setDraftBaseUrl(String(providerConfig.baseUrl || provider.baseUrl || ''));
    setDraftApiKey(String(providerConfig.apiKey || ''));
    setDraftModel(String(providerConfig.model || provider.defaultModel || ''));
    setDraftExtra(providerConfig.extra ? JSON.stringify(providerConfig.extra) : '');
    setSettingsOpen(true);
  }, [loaded, provider.baseUrl, provider.defaultModel, providerConfig]);

  // 列表接口不可用时，不再自动试生成：先问过用户再决定是否花这笔钱。
  const confirmProbe = useCallback(() => {
    Alert.alert(
      '列表接口不可用',
      '该服务的模型列表接口无法访问。可以试生成 1 张小图来验证连通性，但可能产生费用。是否继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '试生成 1 张',
           onPress: async () => {
             if (!mountedRef.current) return;
             const controller = new AbortController();
             detectionControllerRef.current = controller;
             setDetecting(true);
             try {

              const probe = await probeImageProvider({
                provider,
                config: {
                  baseUrl: draftBaseUrl.trim() || provider.baseUrl || '',
                  apiKey: draftApiKey.trim(),
                   model: normalizeModelList(draftModel, provider.defaultModel)[0] || provider.defaultModel || '',
                 },
                 model: normalizeModelList(draftModel, provider.defaultModel)[0] || provider.defaultModel || '',
                 prompt: prompt.trim(),
                 signal: controller.signal,
               });
               if (!mountedRef.current || controller.signal.aborted) return;
               Alert.alert('检测成功', `已连通，试生成 ${probe.images} 张小图（可能产生费用）`);
             } catch (error) {
               if (mountedRef.current && !controller.signal.aborted) {
                 Alert.alert('检测失败', maskSecrets((error && error.message) || '生成接口不可用'));
               }
             } finally {
               if (detectionControllerRef.current === controller) {
                 detectionControllerRef.current = null;
                 if (mountedRef.current) setDetecting(false);
               }

            }
          },
        },
      ]
    );
  }, [draftApiKey, draftBaseUrl, draftModel, prompt, provider]);

  const detectProvider = useCallback(async () => {
    if (detecting) return;
    const controller = new AbortController();
    detectionControllerRef.current = controller;
    setDetecting(true);
    try {
      const result = await detectImageProvider({
        provider,
        config: {
          baseUrl: draftBaseUrl.trim() || provider.baseUrl || '',
          apiKey: draftApiKey.trim(),
           model: normalizeModelList(draftModel, provider.defaultModel)[0] || provider.defaultModel || '',
         },
          model: normalizeModelList(draftModel, provider.defaultModel)[0] || provider.defaultModel || '',
         signal: controller.signal,
       });
       if (!mountedRef.current || controller.signal.aborted) return;
       if (result.ok) {

        const extra = result.modelFound === false
          ? '\n（模型名可能不正确，但接口已连通）'
          : '';
        Alert.alert('检测成功', `${result.message}${extra}`);
       } else if (result.needsProbe) {
         detectionControllerRef.current = null;
         if (mountedRef.current) setDetecting(false);
         confirmProbe();
         return;
       } else {
         Alert.alert('检测失败', result.error || '无法连接');
       }
     } catch (error) {
       if (mountedRef.current && !controller.signal.aborted) {
         Alert.alert('检测失败', maskSecrets((error && error.message) || '无法连接'));
       }
     } finally {
       if (detectionControllerRef.current === controller) {
         detectionControllerRef.current = null;
         if (mountedRef.current) setDetecting(false);
       }
     }

  }, [confirmProbe, detecting, draftApiKey, draftBaseUrl, draftModel, provider]);

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
     const saved = await persistProvider(providerId, {
       baseUrl: draftBaseUrl.trim(),
       apiKey: draftApiKey.trim(),
       model: draftModel.trim(),
       extra,
     });
     if (saved) setSettingsOpen(false);
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
      // 尺寸/大小校验单独隔离：getInfoAsync / Image.getSize 在 content://、
      // ph:// 或 HEIC 上可能抛错，校验失败只降级为跳过，不阻断选图本身。
      try {
        const info = await FileSystem.getInfoAsync(asset.uri);
        const size = Number(asset.size || info.size || 0);
        if (size > MAX_REFERENCE_IMAGE_BYTES) {
          Alert.alert('图片过大', '参考图片不能超过 20 MB。');
          return;
        }
        const dimensions = await getImageDimensions(asset.uri);
        if (dimensions.width * dimensions.height > MAX_REFERENCE_IMAGE_PIXELS) {
          Alert.alert('图片分辨率过高', '参考图片不能超过 2000 万像素。');
          return;
        }
      } catch (error) {
        if (__DEV__) console.warn('[image-gen] reference validation skipped', error);
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
    if (!loaded || generating) return;
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
     const controller = new AbortController();
     const requestRevision = settingsRevisionRef.current;
     generationControllerRef.current = controller;
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
         signal: controller.signal,
       });

        if (!mountedRef.current || controller.signal.aborted) return;
        if (settingsRevisionRef.current !== requestRevision) {
          // 这张图已经花过一次生成额度：结果因配置变更作废时必须明确告知，
          // 不能静默丢弃——用户会以为生成失败或结果凭空消失。
          if (mountedRef.current) {
            Alert.alert('生成结果已作废', '生成期间图源设置已变更，本次结果不再保留。');
          }
          return;
        }
        const generatedAt = Date.now();
       const normalizedResults = response.images.map((image, index) => ({
         ...image,
         id: image.id || `generated-${generatedAt}-${index}-${Math.random().toString(36).slice(2, 7)}`,
       }));
       setResults(current => [...normalizedResults, ...current].slice(0, 30));
     } catch (error) {
       if (mountedRef.current && !controller.signal.aborted) {
         Alert.alert('生成失败', maskSecrets((error && error.message) || '请稍后重试。'));
       }
     } finally {
       if (generationControllerRef.current === controller) {
         generationControllerRef.current = null;
         if (mountedRef.current) setGenerating(false);
       }

    }
  }, [generating, imageMime, imageUri, loaded, model, prompt, provider, providerConfig, seed, size]);

  const saveResult = useCallback(async result => {
    if (busyResult) return;
    setBusyResult(resultToken(result));
    try {
      const format = resolveImageFormat(result);
      let uri = '';
      const dir = `${FileSystem.cacheDirectory}image-gen/`;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      if (result.base64) {
        uri = `${dir}generated-${Date.now()}.${format.ext}`;
        await FileSystem.writeAsStringAsync(uri, result.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } else if (result.url) {
        uri = `${dir}generated-${Date.now()}.${format.ext}`;
        // downloadAsync 没有超时参数，用 Promise.race 兜底，避免结果下载永久挂起。
        const downloaded = await Promise.race([
          FileSystem.downloadAsync(result.url, uri),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('图片下载超时')), 60000);
          }),
        ]);
        uri = downloaded.uri;
      }
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available && uri) {
        await Sharing.shareAsync(uri, { mimeType: format.mime, dialogTitle: '保存图片' });
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
        <FieldLabel style={styles.label}>服务</FieldLabel>
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

        <FieldLabel style={styles.label}>模型</FieldLabel>
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

        <FieldLabel style={styles.label}>提示词</FieldLabel>
        <TextField
          style={styles.promptInput}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="描述你想生成的画面..."
          multiline
          textAlignVertical="top"
        />

        <FieldLabel style={styles.label}>尺寸</FieldLabel>
        <View style={styles.chipRow}>
          {SIZES.map(item => (
            <Chip
              key={item}
              label={item}
              active={item === size}
              onPress={() => setSize(item)}
            />
          ))}
        </View>

        <FieldLabel style={styles.label}>随机种子（可选）</FieldLabel>
        <TextField
          value={seed}
          onChangeText={value => setSeed(value.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder="留空为随机"
        />

        <FieldLabel style={styles.label}>输入图片（图生图，可选）</FieldLabel>
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

        <PrimaryButton
          title="生成"
          icon="sparkles"
          onPress={onGenerate}
          disabled={!loaded || generating}
          loading={generating}
          style={styles.generateButton}
        />
        {generating ? <Text style={styles.generatingHint}>生成中，请稍候...</Text> : null}

        {results.length > 0 ? (
          <>
            <FieldLabel style={styles.label}>结果画廊</FieldLabel>
            <View style={styles.gallery}>
              {results.map((result, index) => {
                const uri = result.url || (result.base64 ? `data:image/png;base64,${result.base64}` : '');
                const key = `${resultToken(result)}:${index}`;
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.galleryItem}
                    onPress={() => onPressResult(result)}
                    activeOpacity={0.85}
                  >
                    {uri ? <Image source={{ uri }} style={styles.galleryImage} resizeMode="cover" /> : null}
                    {busyResult === resultToken(result) ? (
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
        <Pressable style={styles.modalBackdrop} onPress={() => setProviderOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
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
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modelOpen} transparent animationType="fade" onRequestClose={() => setModelOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
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
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{provider.label} 设置</Text>
            <FieldHint style={styles.hint}>密钥仅保存在本机，不会写入日志或文档。</FieldHint>
            {provider.keyHint ? (
              <FieldHint style={styles.hint}>密钥：{provider.keyHint}</FieldHint>
            ) : null}
            {provider.corsNote ? (
              <FieldHint style={styles.hint}>
                CORS：{provider.corsNote}
              </FieldHint>
            ) : null}
            <FieldLabel style={styles.label}>API 地址</FieldLabel>
            <TextField
              value={draftBaseUrl}
              onChangeText={setDraftBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider.baseUrlPlaceholder || provider.baseUrl || 'https://example.com/v1/images'}
            />
            <FieldLabel style={styles.label}>API Key</FieldLabel>
            <TextField
              value={draftApiKey}
              onChangeText={setDraftApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="sk-..."
            />
            <TouchableOpacity
              style={[styles.selectButton, styles.apiKeyButton]}
              onPress={openApiKeyUrl}
              activeOpacity={0.8}
            >
              <Ionicons name="open-outline" size={16} color={theme.colors.textMuted} />
              <Text style={styles.selectButtonText}>获取 API Key</Text>
            </TouchableOpacity>
            <FieldLabel style={styles.label}>模型名（可用逗号或换行分隔多个）</FieldLabel>
            <TextField
              value={draftModel}
              onChangeText={setDraftModel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider.defaultModel || '模型名'}
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
            <FieldLabel style={styles.label}>额外参数（JSON，可选）</FieldLabel>
            <TextField
              style={styles.extraInput}
              value={draftExtra}
              onChangeText={setDraftExtra}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              placeholder='{"quality":"hd"}'
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

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
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
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 6 },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 40 },
  label: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: tokens.spacing.lg, marginBottom: tokens.spacing.sm },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 6 },
  promptInput: { minHeight: 96 },
  extraInput: { minHeight: 72 },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectButtonGhost: { backgroundColor: theme.colors.surface, flex: 1, justifyContent: 'center', marginRight: 10 },
  generateButtonDisabled: { opacity: tokens.opacity.disabled },
  detectButton: {
    justifyContent: 'center',
    marginTop: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  apiKeyButton: {
    justifyContent: 'center',
    marginTop: 10,
    borderWidth: tokens.border.thin,
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
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderStyle: 'dashed',
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: 18,
  },
  uploadButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 8 },
  previewRow: { alignSelf: 'flex-start' },
  preview: { width: 120, height: 120, borderRadius: tokens.radius.md, backgroundColor: theme.colors.surface },
  removeImage: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: theme.colors.danger,
    borderRadius: tokens.radius.pill,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  generateButton: {
    marginTop: 24,
  },
  generatingHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), textAlign: 'center', marginTop: 10 },
  gallery: { flexDirection: 'row', flexWrap: 'wrap' },
  galleryItem: {
    width: '48%',
    aspectRatio: 1,
    borderRadius: tokens.radius.md,
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
    borderTopLeftRadius: tokens.radius.bubble,
    borderTopRightRadius: tokens.radius.bubble,
    padding: 20,
    paddingBottom: 32,
  },
  modalTitle: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800', marginBottom: 8 },
  modalList: { maxHeight: 280 },
  modalRow: {
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: tokens.radius.md,
  },
  modalRowText: { color: theme.colors.textMuted, fontSize: fonts.scaled(15) },
  modalRowTextActive: { color: theme.colors.primaryMuted, fontWeight: '700' },
  modalActions: { flexDirection: 'row', marginTop: 20 },
});
