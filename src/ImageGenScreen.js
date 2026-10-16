import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
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
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';

import { IMAGE_PROVIDERS, getImageProvider, providerRequiresApiKey } from './imageGen/providers.js';
import { generateImage, detectImageProvider, probeImageProvider } from './imageGen/index.js';
import { getImageGenSettings, saveImageGenSettings } from './storage/settings.js';
import { resolveImageFormat } from './imageGen/imageResultFormat.js';
// FEAT-AC13 P0-2：参考图格式前置校验（纯函数，Node 直测）。
import { isRejectedReferenceFormat } from './imageGen/referenceFormat.js';
import createStyles from './imageGen/imageGenScreenStyles.js';
import ProviderSettingsModal from './imageGen/ProviderSettingsModal.js';
import ChapterModal from './books/ChapterModal.js';
import { getImageDimensions, takePhoto } from './chat/attachments.js';
import { Chip, FieldHint, FieldLabel, PrimaryButton, TextField, TopicButton } from './ui/index.js';
import PaneHeader from './ui/PaneHeader.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { maskSecrets } from './storage/secrets.js';

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

export default function ImageGenScreen() {
  const navigation = useNavigation();
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
  const [generateProgress, setGenerateProgress] = useState(null);
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
  const { t } = useTranslation();
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

  // 失焦时中止生成/检测：Stack 化后切页面会卸载组件（触发上面的 cleanup），
  // 但 Tab 切走不卸载——用 useFocusEffect 补失焦清理。
  useFocusEffect(
    useCallback(() => () => {
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
      detectionControllerRef.current?.abort();
      detectionControllerRef.current = null;
    }, [])
  );

  useEffect(() => {
    (async () => {
      try {
        const stored = await getImageGenSettings();
        if (!mountedRef.current) return;
        const normalized = stored.activeProvider ? stored : { ...stored, activeProvider: DEFAULT_PROVIDER };
        lastSavedSettingsRef.current = normalized;
        setSettings(normalized);
      } catch (error) {
        if (mountedRef.current) Alert.alert(t('imageGen.alert.readConfigFailed.title'), t('imageGen.alert.readConfigFailed.body'));
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
        if (mountedRef.current) Alert.alert(t('imageGen.alert.saveFailed.title'), t('imageGen.alert.saveFailed.bodyStorage'));
        return false;
      }
    });
    settingsSaveQueueRef.current = task.catch(() => false);
    return task;
  }, [loaded]);

  const persistProvider = useCallback((id, patch) => {
    if (!loaded) return Promise.resolve(false);
    const hadGeneration = generationControllerRef.current != null;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    // abort 后把生成中状态复位：onGenerate 的 finally 靠
    // `generationControllerRef.current === controller` 判断，ref 已被置 null 就不会再复位，
    // 否则改配置后 generating 永久卡 true，后续生成被 `if (generating) return` 全拦下。
    if (hadGeneration && mountedRef.current) {
      setGenerating(false);
      setGenerateProgress(null);
    }
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
      t('imageGen.alert.probeUnavailable.title'),
      t('imageGen.alert.probeUnavailable.body'),
      [
        { text: t('imageGen.cancel'), style: 'cancel' },
        {
          text: t('imageGen.probe.button'),
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
               Alert.alert(t('imageGen.alert.detectOk.title'), t('imageGen.probe.okBody', { n: probe.images }));
             } catch (error) {
               if (mountedRef.current && !controller.signal.aborted) {
                 Alert.alert(t('imageGen.alert.detectFailed.title'), maskSecrets((error && error.message) || t('imageGen.probe.failedBody')));
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
  }, [draftApiKey, draftBaseUrl, draftModel, prompt, provider, t]);

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
          ? `\n${t('imageGen.detect.modelNote')}`
          : '';
        Alert.alert(t('imageGen.alert.detectOk.title'), `${result.message}${extra}`);
       } else if (result.needsProbe) {
         detectionControllerRef.current = null;
         if (mountedRef.current) setDetecting(false);
         confirmProbe();
         return;
       } else {
         Alert.alert(t('imageGen.alert.detectFailed.title'), result.error || t('imageGen.detect.unreachable'));
       }
     } catch (error) {
       if (mountedRef.current && !controller.signal.aborted) {
         Alert.alert(t('imageGen.alert.detectFailed.title'), maskSecrets((error && error.message) || t('imageGen.detect.unreachable')));
       }
     } finally {
       if (detectionControllerRef.current === controller) {
         detectionControllerRef.current = null;
         if (mountedRef.current) setDetecting(false);
       }
     }

  }, [confirmProbe, detecting, draftApiKey, draftBaseUrl, draftModel, provider, t]);

  const openApiKeyUrl = useCallback(async () => {
    if (!provider.apiKeyUrl) {
      Alert.alert(t('imageGen.alert.getApiKey.title'), provider.keyHintKey ? t(provider.keyHintKey) : t('imageGen.alert.getApiKey.body'));
      return;
    }
    try {
      const canOpen = await Linking.canOpenURL(provider.apiKeyUrl);
      if (!canOpen) {
        Alert.alert(t('imageGen.alert.openLinkFailed.title'), provider.apiKeyUrl);
        return;
      }
      await Linking.openURL(provider.apiKeyUrl);
    } catch (error) {
      Alert.alert(t('imageGen.alert.openLinkFailed.title'), provider.apiKeyUrl);
    }
  }, [provider.apiKeyUrl, provider.keyHintKey, t]);

  const confirmSettings = useCallback(async () => {
    let extra = {};
    const extraText = draftExtra.trim();
    if (extraText) {
      try {
        const parsed = JSON.parse(extraText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          Alert.alert(t('imageGen.alert.extraInvalid.title'), t('imageGen.alert.extraInvalid.bodyObject'));
          return;
        }
        extra = parsed;
      } catch (error) {
        Alert.alert(t('imageGen.alert.extraInvalid.title'), t('imageGen.alert.extraInvalid.bodyJson'));
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
  }, [draftApiKey, draftBaseUrl, draftExtra, draftModel, persistProvider, providerId, t]);

  // 参考图落地：相册选图与拍照共用同一套校验与状态写入（尺寸/大小校验失败只提示、
  // 不落地；校验异常降级为跳过，不阻断已选中的图）。
  const applyReferenceImage = useCallback(async ({ uri, mime, name, size }) => {
    // FEAT-AC13 P0-2：HEIC/HEIF 前置拦截。**必须在 isImageLike 之前**——顺序是有意的：
    //
    // ① isImageLike 的扩展名清单是 `png|jpe?g|webp|bmp|gif`（**不含 heic**），所以
    //    「有 mime=image/heic」的图会被它放行（`image/` 前缀命中）→ 需要本检查兜住；
    // ② 而「只有文件名 .heic、没 mime」的图会被 isImageLike 拦下，但给的是笼统的
    //    「不支持的文件 / 请选择图片文件」——用户拿不到「换 PNG/JPG」这个下一步。
    // 把本检查放前面，两种形态都拿到**可操作**的提示（HEIC 是 iPhone 相册默认格式，
    // 用户极可能就是这么选进来的，说清楚比笼统拒绝重要）。
    //
    // 为什么拦：isImageLike 只查 `image/` 前缀，HEIC 会一路走到上游——而
    // /v1/images/edits 只收 png/jpg/webp，回来的是 400，用户只看到「生成失败（HTTP 400）」。
    // **宁可拒绝得明白，不要放行后收 400**（转码另立案，本轮不做）。
    if (isRejectedReferenceFormat({ mime, name })) {
      Alert.alert(
        t('imageGen.alert.referenceFormatUnsupported.title'),
        t('imageGen.alert.referenceFormatUnsupported.body')
      );
      return;
    }
    if (!isImageLike(name, mime)) {
      Alert.alert(t('imageGen.alert.unsupportedFile.title'), t('imageGen.alert.unsupportedFile.body'));
      return;
    }
    // 尺寸/大小校验单独隔离：getInfoAsync / Image.getSize 在 content://、
    // ph:// 或 HEIC 上可能抛错，校验失败只降级为跳过，不阻断选图本身。
    try {
      const info = await FileSystem.getInfoAsync(uri);
      const bytes = Number(size || info.size || 0);
      if (bytes > MAX_REFERENCE_IMAGE_BYTES) {
        Alert.alert(t('imageGen.alert.imageTooLarge.title'), t('imageGen.alert.imageTooLarge.body'));
        return;
      }
      const dimensions = await getImageDimensions(uri);
      if (dimensions.width * dimensions.height > MAX_REFERENCE_IMAGE_PIXELS) {
        Alert.alert(t('imageGen.alert.imageTooManyPixels.title'), t('imageGen.alert.imageTooManyPixels.body'));
        return;
      }
    } catch (error) {
      if (__DEV__) console.warn('[image-gen] reference validation skipped', error);
    }
    setImageUri(uri);
    setImageMime(mime || 'image/png');
  }, [t]);

  const pickImage = useCallback(async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets || !picked.assets.length) return;
      const asset = picked.assets[0];
      await applyReferenceImage({
        uri: asset.uri,
        mime: asset.mimeType,
        name: asset.name,
        size: asset.size,
      });
    } catch (error) {
      Alert.alert(t('imageGen.alert.pickImageFailed.title'), t('imageGen.alert.pickImageFailed.body'));
    }
  }, [applyReferenceImage, t]);

  // 拍照直连图生图参考图。权限被拒时给出可操作提示（与聊天拍照同语义）。
  const captureImage = useCallback(async () => {
    try {
      const picked = await takePhoto();
      if (picked && picked.denied) {
        Alert.alert(t('imageGen.alert.cameraPerm.title'), t('imageGen.alert.cameraPerm.body'));
        return;
      }
      if (!picked) return;
      await applyReferenceImage({
        uri: picked.uri,
        mime: picked.mime,
        name: picked.name,
        size: picked.size,
      });
    } catch (error) {
      Alert.alert(t('imageGen.alert.takePhotoFailed.title'), t('imageGen.alert.takePhotoFailed.body'));
    }
  }, [applyReferenceImage, t]);

  const clearImage = useCallback(() => {
    setImageUri('');
    setImageMime('image/png');
  }, []);

  const onGenerate = useCallback(async () => {
    if (!loaded || generating) return;
    const text = prompt.trim();
    if (!text && !imageUri) {
      Alert.alert(t('imageGen.alert.promptRequired.title'), t('imageGen.alert.promptRequired.body'));
      return;
    }
    if (!String(providerConfig.baseUrl || provider.baseUrl || '').trim()) {
      Alert.alert(t('imageGen.alert.baseUrlRequired.title'), t('imageGen.alert.openKeyPanel.body'));
      return;
    }
    if (providerRequiresApiKey(provider) && !String(providerConfig.apiKey || '').trim()) {
      Alert.alert(t('imageGen.alert.apiKeyRequired.title'), t('imageGen.alert.openKeyPanel.body'));
      return;
    }
    if (imageUri && !provider.i2i) {
      Alert.alert(t('imageGen.alert.i2iUnsupported.title'), t('imageGen.alert.i2iUnsupported.body'));
      return;
    }
     const controller = new AbortController();
     const requestRevision = settingsRevisionRef.current;
     generationControllerRef.current = controller;
     setGenerating(true);
     setGenerateProgress(null);
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
         onProgress: percent => {
           if (mountedRef.current) setGenerateProgress(percent);
         },
       });
        if (!mountedRef.current || controller.signal.aborted) return;
        if (settingsRevisionRef.current !== requestRevision) {
          // 这张图已经花过一次生成额度：结果因配置变更作废时必须明确告知，
          // 不能静默丢弃——用户会以为生成失败或结果凭空消失。
          if (mountedRef.current) {
            Alert.alert(t('imageGen.alert.resultDiscarded.title'), t('imageGen.alert.resultDiscarded.body'));
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
         Alert.alert(t('imageGen.alert.generateFailed.title'), maskSecrets((error && error.message) || t('imageGen.alert.retryLater')));
       }
       } finally {
         if (generationControllerRef.current === controller) {
           generationControllerRef.current = null;
           if (mountedRef.current) {
             setGenerating(false);
             setGenerateProgress(null);
           }
         }

    }
  }, [generating, imageMime, imageUri, loaded, model, prompt, provider, providerConfig, seed, size, t]);

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
            setTimeout(() => reject(new Error(t('imageGen.error.downloadTimeout'))), 60000);
          }),
        ]);
        uri = downloaded.uri;
      }
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available && uri) {
        await Sharing.shareAsync(uri, { mimeType: format.mime, dialogTitle: t('imageGen.save.dialogTitle') });
      } else if (uri) {
        Alert.alert(t('imageGen.alert.saved.title'), t('imageGen.alert.saved.body', { uri }));
      } else {
        Alert.alert(t('imageGen.alert.cannotSave.title'), t('imageGen.alert.cannotSave.body'));
      }
    } catch (error) {
      // 与 :477 同形：透出真实原因——:511 刚构造的「下载超时」原先被换成笼统文案（死代码）。
      Alert.alert(t('imageGen.alert.saveFailed.title'), maskSecrets((error && error.message) || t('imageGen.alert.retryLater')));
    } finally {
      if (mountedRef.current) setBusyResult('');
    }
  }, [busyResult, t]);

  const onPressResult = useCallback(result => {
    Alert.alert(t('imageGen.alert.imageAction.title'), t('imageGen.alert.imageAction.body'), [
      { text: t('imageGen.cancel'), style: 'cancel' },
      { text: t('imageGen.saveShare'), onPress: () => saveResult(result) },
    ]);
  }, [saveResult, t]);

  const imagePreview = useMemo(() => (imageUri ? { uri: imageUri } : null), [imageUri]);

  return (
    <KeyboardAvoidingView
      style={[styles.container]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <PaneHeader
        title={t('ext.home.image')}
        onBack={() => navigation.goBack()}
        right={(
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.configButton}
              onPress={openSettings}
              activeOpacity={0.8}
            >
              <Ionicons name="settings-outline" size={16} color={theme.colors.primaryContrast} />
              <Text
                style={styles.keyButtonText}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {t(provider.labelKey)} · {model || t('common.notSet')}
              </Text>
            </TouchableOpacity>
            <TopicButton
              style={styles.topicButton}
              onPress={() => setTopic('image-api')}
              accessibilityLabel={t('imageGen.tutorial.a11y')}
            />
          </View>
        )}
      />

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        {results.length > 0 ? (
          <>
            <FieldLabel style={styles.label}>{t('imageGen.galleryLabel')}</FieldLabel>
            <Text style={styles.aigcHint}>{t('imageGen.aigcHint')}</Text>
            <View style={styles.gallery}>
              {results.map((result, index) => {
                const uri = result.url || (result.base64 ? `data:${resolveImageFormat(result).mime};base64,${result.base64}` : ''); // MIME 按真实格式（jpg/webp/gif），写死 png 与字节不符
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

        <FieldLabel style={styles.label}>{t('imageGen.serviceLabel')}</FieldLabel>
        <TouchableOpacity style={styles.selectButton} onPress={() => setProviderOpen(true)} activeOpacity={0.8}>
          <Text style={styles.selectButtonText}>{t(provider.labelKey)}</Text>
          <Ionicons name="chevron-down" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>
        {provider.networkNoteKey ? (
          <View style={styles.networkNoteRow}>
            <Ionicons name="globe-outline" size={14} color={theme.colors.textMuted} />
            <Text style={styles.networkNoteText}>{t(provider.networkNoteKey)}</Text>
          </View>
        ) : null}

        <FieldLabel style={styles.label}>{t('imageGen.modelLabel')}</FieldLabel>
        <TouchableOpacity
          style={styles.selectButton}
          onPress={() => {
            if (!modelList.length) {
              Alert.alert(t('imageGen.alert.modelMissing.title'), t('imageGen.alert.modelMissing.body'));
              return;
            }
            setModelOpen(true);
          }}
          activeOpacity={0.8}
        >
          <Text style={[styles.selectButtonText, !model && styles.placeholderText]}>
            {model || t('imageGen.modelEmpty')}
          </Text>
          <Ionicons name="chevron-down" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>

        <FieldLabel style={styles.label}>{t('imageGen.sizeLabel')}</FieldLabel>
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

        <FieldLabel style={styles.label}>{t('imageGen.seedLabel')}</FieldLabel>
        <TextField
          value={seed}
          onChangeText={value => setSeed(value.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder={t('imageGen.seedPlaceholder')}
        />

        <FieldLabel style={styles.label}>{t('imageGen.inputImageLabel')}</FieldLabel>
        <FieldHint style={styles.hint}>{t('imageGen.inputImageHint')}</FieldHint>
        {imagePreview ? (
          <View style={styles.previewRow}>
            <Image source={imagePreview} style={styles.preview} resizeMode="cover" />
            <TouchableOpacity style={styles.removeImage} onPress={clearImage} hitSlop={8}>
              <Ionicons name="close" size={16} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.uploadRow}>
            <TouchableOpacity style={[styles.uploadButton, styles.uploadButtonHalf]} onPress={pickImage} activeOpacity={0.8}>
              <Ionicons name="image-outline" size={18} color={theme.colors.textMuted} />
              <Text style={styles.uploadButtonText}>{t('imageGen.pickImage')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.uploadButton, styles.uploadButtonHalf]} onPress={captureImage} activeOpacity={0.8}>
              <Ionicons name="camera-outline" size={18} color={theme.colors.textMuted} />
              <Text style={styles.uploadButtonText}>{t('imageGen.takePhoto')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {generating ? <Text style={styles.generatingHint}>{generateProgress !== null ? t('imageGen.generating.progress', { n: generateProgress }) : t('imageGen.generating.wait')}</Text> : null}
      </ScrollView>

      <View style={styles.bottomBar}>
        <TextField
          style={styles.bottomPromptInput}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={t('imageGen.promptPlaceholder')}
          multiline
          textAlignVertical="top"
        />
        <PrimaryButton
          title={t('imageGen.generate')}
          icon="sparkles"
          onPress={onGenerate}
          disabled={!loaded || generating}
          loading={generating}
          style={styles.bottomGenerateButton}
        />
      </View>

      <Modal visible={providerOpen} transparent animationType="slide" onRequestClose={() => setProviderOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setProviderOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t('imageGen.pickService')}</Text>
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

      <Modal visible={modelOpen} transparent animationType="slide" onRequestClose={() => setModelOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t('imageGen.pickModel')}</Text>
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

      <ProviderSettingsModal
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        styles={styles}
        theme={theme}
        t={t}
        provider={provider}
        draftBaseUrl={draftBaseUrl}
        setDraftBaseUrl={setDraftBaseUrl}
        draftApiKey={draftApiKey}
        setDraftApiKey={setDraftApiKey}
        draftModel={draftModel}
        setDraftModel={setDraftModel}
        draftExtra={draftExtra}
        setDraftExtra={setDraftExtra}
        detecting={detecting}
        detectProvider={detectProvider}
        openApiKeyUrl={openApiKeyUrl}
        confirmSettings={confirmSettings}
      />

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title={t('imageGen.tutorial.title')}
      />
    </KeyboardAvoidingView>
  );
}

