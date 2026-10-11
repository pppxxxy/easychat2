// 角色编辑页的「专属配置」折叠区：为本角色单独指定聊天 API / OCR 模型 API /
// TTS API + 音声 / 语音转文字 API，或逐项「跟随全局」。
//
// 为什么整块拆成独立组件：CharacterDetailScreen.js 已经顶到架构棘轮基线（1714 行），
// 屏幕本身只留 import + 一行装配；状态、加载与落盘全部在这里。
//
// 三个界面纪律（都有测试/注入验证）：
// 1. **「跟随全局」必须显示全局值**：只写「跟随全局」而不写跟到哪，用户无从判断；
//    每个选择器的「跟随全局」项都带 meta（全局配置名 / 全局音色 / 全局转写来源）。
// 2. **配过就要看得出来**：每项右上角有「专属」标记，折叠区标题右侧给「配过几项」的
//    计数徽章——用户一眼看出这个角色被单独配过。
// 3. **选中的配置被删了要明说**：解析层会把 missing 报上来（见 character/runtimeConfig.js），
//    这里显示醒目提示 + 仍以原文显示那个已失效的 id，绝不静默留白。
//
// 密钥：本组件没有任何密钥输入框——只选既有配置的 id，密钥仍由既有保险箱保护。
// 落盘走 storage/characterOverrides.js（独立键 + schema 版本 + 角色删除钩子）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { CollapsibleSection, CollapsibleSelect, FieldHint } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getActiveModel, getApiConfigs } from '../storage/apiConfigs.js';
import { getImageRecognitionSettings } from '../storage/settings/imageRecognition.js';
import { getTranscriptionSettings, getTtsSettings } from '../storage/settings/tts.js';
import {
  countCharacterOverrides,
  getCharacterOverrides,
  normalizeCharacterOverrides,
  saveCharacterOverrides,
} from '../storage/characterOverrides.js';
import { TTS_PROVIDERS, getTtsProvider } from '../tts/providers.js';
import { createCharacterStyles } from './characterStyles.js';

const EMPTY_TTS = { autoBroadcast: false, activeProvider: 'system', providers: {} };
const EMPTY_TRANSCRIPTION = { activeId: '', configs: [] };

function nameOf(item) {
  return String((item && (item.name || item.id)) || '');
}

// provider id → i18n 词条 key。**不能**直接拼 `tts.providerName.${id}`：provider id 里
// 有连字符（xiaomi-mimo / iflytek-spark / tencent-cloud），而词条 key 只允许字母数字段
//（tests/i18n.test.mjs 的格式不变量）。新增 provider 时在这里补一行 + 两个语言的词条。
const TTS_PROVIDER_NAME_KEYS = {
  system: 'tts.providerName.system',
  'xiaomi-mimo': 'tts.providerName.xiaomiMimo',
  siliconflow: 'tts.providerName.siliconflow',
  'iflytek-spark': 'tts.providerName.iflytekSpark',
  stepfun: 'tts.providerName.stepfun',
  'tencent-cloud': 'tts.providerName.tencentCloud',
  aliyun: 'tts.providerName.aliyun',
  baidu: 'tts.providerName.baidu',
  volcano: 'tts.providerName.volcano',
  minimax: 'tts.providerName.minimax',
};

// provider 显示名：tts/providers.js 的 label 是中文常量（英文界面下不能直接用），
// 按 id 查 i18n 词条；查不到（新增 provider 忘了补词条）才回落到常量 label，不显示空白或键名。
function providerLabel(t, provider) {
  const id = String((provider && provider.id) || '');
  if (!id) return '';
  const key = TTS_PROVIDER_NAME_KEYS[id];
  if (!key) return String(provider.label || id);
  const translated = t(key);
  return translated === key ? String(provider.label || id) : translated;
}

function findById(list, id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  return (Array.isArray(list) ? list : []).find(item => String(item.id) === wanted) || null;
}

export default function CharacterOverridesSection({ characterId }) {
  const { t } = useTranslation();
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createCharacterStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const id = String(characterId || '');
  const [loaded, setLoaded] = useState(false);
  const [overrides, setOverrides] = useState(() => normalizeCharacterOverrides(null));
  const [apiConfigs, setApiConfigs] = useState([]);
  const [activeApiId, setActiveApiId] = useState('');
  const [ttsSettings, setTtsSettings] = useState(EMPTY_TTS);
  const [transcription, setTranscription] = useState(EMPTY_TRANSCRIPTION);
  const [ocrSettings, setOcrSettings] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const overridesRef = useRef(overrides);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 每次进页面/换角色都重读：角色专属配置与全局配置都可能刚被改过（改完立即生效）。
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    Promise.all([
      getCharacterOverrides(id).catch(() => null),
      getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
      getTtsSettings().catch(() => null),
      getTranscriptionSettings().catch(() => null),
      getImageRecognitionSettings().catch(() => null),
    ]).then(([stored, api, tts, tr, ocr]) => {
      if (cancelled) return;
      const next = stored || normalizeCharacterOverrides(null);
      overridesRef.current = next;
      setOverrides(next);
      setApiConfigs(Array.isArray(api && api.configs) ? api.configs : []);
      setActiveApiId(String((api && api.activeId) || ''));
      setTtsSettings(tts || EMPTY_TTS);
      setTranscription(tr || EMPTY_TRANSCRIPTION);
      setOcrSettings(ocr);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [id]);

  // 选择即落盘（都是离散选择，不需要防抖）。存储层整条覆盖写并归一化，天然幂等。
  const applyPatch = useCallback(patch => {
    const next = { ...overridesRef.current, ...patch };
    overridesRef.current = next;
    setOverrides(next);
    setSaveFailed(false);
    return saveCharacterOverrides(id, next)
      .then(saved => {
        if (saved && mountedRef.current) {
          overridesRef.current = saved;
          setOverrides(saved);
        }
        return saved;
      })
      .catch(() => {
        if (mountedRef.current) setSaveFailed(true);
      });
  }, [id]);

  if (!loaded) return null;

  const overriddenCount = countCharacterOverrides(overrides);
  const followGlobal = t('character.overrides.followGlobal');

  // 每项的标题行：左侧项名 + 右侧「专属」标记（配过才显示）。
  const head = (title, overridden) => (
    <View style={styles.overrideItemHead}>
      <Text style={styles.overrideItemTitle}>{title}</Text>
      {overridden ? (
        <View style={styles.overrideBadge}>
          <Text style={styles.overrideBadgeText}>{t('character.overrides.badge')}</Text>
        </View>
      ) : null}
    </View>
  );

  // ---- 1. 专属聊天 API（可选专属模型）----
  const chatGlobal = findById(apiConfigs, activeApiId) || apiConfigs[0] || null;
  const chatPicked = findById(apiConfigs, overrides.chatApiConfigId);
  const chatOptions = [
    { value: '', label: followGlobal, meta: chatGlobal ? nameOf(chatGlobal) : t('character.overrides.globalMissing') },
    ...apiConfigs.map(item => ({ value: String(item.id), label: nameOf(item), meta: String(item.baseUrl || '') })),
  ];
  const chatModels = chatPicked && Array.isArray(chatPicked.models) ? chatPicked.models : [];
  const chatModelOptions = chatPicked ? [
    { value: '', label: t('character.overrides.followModel'), meta: getActiveModel(chatPicked) },
    ...chatModels.map(model => ({ value: model, label: model })),
  ] : [];

  // ---- 2. 专属 OCR 模型 API（可选专属模型名）----
  const ocrGlobal = ocrSettings || { apiConfigId: '', model: '' };
  const ocrGlobalConfig = findById(apiConfigs, ocrGlobal.apiConfigId);
  const ocrPicked = findById(apiConfigs, overrides.ocrApiConfigId);
  const ocrOptions = [
    {
      value: '',
      label: followGlobal,
      meta: ocrGlobalConfig ? `${nameOf(ocrGlobalConfig)}${ocrGlobal.model ? ` · ${ocrGlobal.model}` : ''}` : t('character.overrides.globalMissing'),
    },
    ...apiConfigs.map(item => ({ value: String(item.id), label: nameOf(item), meta: String(item.baseUrl || '') })),
  ];
  const ocrModels = ocrPicked && Array.isArray(ocrPicked.models) ? ocrPicked.models : [];
  const ocrModelOptions = ocrPicked ? [
    { value: '', label: t('character.overrides.followModel'), meta: getActiveModel(ocrPicked) },
    ...ocrModels.map(model => ({ value: model, label: model })),
  ] : [];

  // ---- 3. 专属 TTS API + 专属音声 ----
  const ttsGlobalId = String(ttsSettings.activeProvider || 'system');
  const ttsEffectiveId = String(overrides.ttsProviderId || '') || ttsGlobalId;
  const ttsEffectiveProvider = getTtsProvider(ttsEffectiveId);
  const ttsProviderConfig = (ttsSettings.providers && ttsSettings.providers[ttsEffectiveId]) || {};
  const ttsGlobalVoice = String(ttsProviderConfig.voice || '');
  const ttsProviderOptions = [
    { value: '', label: followGlobal, meta: providerLabel(t, getTtsProvider(ttsGlobalId)) },
    ...TTS_PROVIDERS.filter(item => item.unsupported !== true)
      .map(item => ({ value: item.id, label: providerLabel(t, item) })),
  ];
  const ttsVoices = Array.isArray(ttsEffectiveProvider.voices) ? ttsEffectiveProvider.voices : [];
  const ttsVoiceOptions = ttsVoices.length > 0 ? [
    {
      value: '',
      label: t('character.overrides.followVoice'),
      meta: ttsGlobalVoice || t('character.overrides.voiceDefault'),
    },
    ...ttsVoices.map(voice => ({ value: voice, label: voice })),
  ] : [];

  // ---- 4. 专属语音转文字 API ----
  const transcriptionConfigs = Array.isArray(transcription.configs) ? transcription.configs : [];
  const transcriptionGlobal = findById(transcriptionConfigs, transcription.activeId);
  const transcriptionPicked = findById(transcriptionConfigs, overrides.transcriptionConfigId);
  const transcriptionOptions = [
    {
      value: '',
      label: followGlobal,
      meta: transcriptionGlobal ? nameOf(transcriptionGlobal) : t('character.overrides.followChatSource'),
    },
    ...transcriptionConfigs.map(item => ({ value: String(item.id), label: nameOf(item), meta: String(item.baseUrl || '') })),
  ];

  return (
    <CollapsibleSection
      title={t('character.overrides.title')}
      icon="options-outline"
      count={overriddenCount > 0 ? String(overriddenCount) : undefined}
    >
      <FieldHint style={styles.hint}>{t('character.overrides.hint')}</FieldHint>

      <View style={styles.overrideItem}>
        {head(t('character.overrides.chat'), !!overrides.chatApiConfigId)}
        <CollapsibleSelect
          value={overrides.chatApiConfigId}
          valueLabel={overrides.chatApiConfigId && !chatPicked ? overrides.chatApiConfigId : undefined}
          options={chatOptions}
          onSelect={value => applyPatch({ chatApiConfigId: value, chatModel: '' })}
        />
        {overrides.chatApiConfigId && !chatPicked ? (
          <FieldHint style={styles.overrideWarn}>
            {t('character.overrides.missing', { id: overrides.chatApiConfigId })}
          </FieldHint>
        ) : null}
        {chatPicked ? (
          <CollapsibleSelect
            style={styles.overrideSubSelect}
            label={t('character.overrides.model')}
            value={overrides.chatModel}
            options={chatModelOptions}
            onSelect={value => applyPatch({ chatModel: value })}
          />
        ) : null}
      </View>

      <View style={styles.overrideItem}>
        {head(t('character.overrides.ocr'), !!overrides.ocrApiConfigId)}
        <FieldHint style={styles.hint}>{t('character.overrides.ocrHint')}</FieldHint>
        <CollapsibleSelect
          value={overrides.ocrApiConfigId}
          valueLabel={overrides.ocrApiConfigId && !ocrPicked ? overrides.ocrApiConfigId : undefined}
          options={ocrOptions}
          onSelect={value => applyPatch({ ocrApiConfigId: value, ocrModel: '' })}
        />
        {overrides.ocrApiConfigId && !ocrPicked ? (
          <FieldHint style={styles.overrideWarn}>
            {t('character.overrides.missing', { id: overrides.ocrApiConfigId })}
          </FieldHint>
        ) : null}
        {ocrPicked ? (
          <CollapsibleSelect
            style={styles.overrideSubSelect}
            label={t('character.overrides.model')}
            value={overrides.ocrModel}
            options={ocrModelOptions}
            onSelect={value => applyPatch({ ocrModel: value })}
          />
        ) : null}
      </View>

      <View style={styles.overrideItem}>
        {head(t('character.overrides.tts'), !!(overrides.ttsProviderId || overrides.ttsVoice))}
        <CollapsibleSelect
          value={overrides.ttsProviderId}
          valueLabel={overrides.ttsProviderId && !TTS_PROVIDERS.some(item => item.id === overrides.ttsProviderId)
            ? overrides.ttsProviderId
            : undefined}
          options={ttsProviderOptions}
          onSelect={value => applyPatch({ ttsProviderId: value, ttsVoice: '' })}
        />
        {overrides.ttsProviderId && !TTS_PROVIDERS.some(item => item.id === overrides.ttsProviderId) ? (
          <FieldHint style={styles.overrideWarn}>
            {t('character.overrides.missing', { id: overrides.ttsProviderId })}
          </FieldHint>
        ) : null}
        {ttsVoiceOptions.length > 0 ? (
          <CollapsibleSelect
            style={styles.overrideSubSelect}
            label={t('character.overrides.voice')}
            value={overrides.ttsVoice}
            options={ttsVoiceOptions}
            onSelect={value => applyPatch({ ttsVoice: value })}
          />
        ) : null}
      </View>

      <View style={styles.overrideItem}>
        {head(t('character.overrides.transcription'), !!overrides.transcriptionConfigId)}
        <CollapsibleSelect
          value={overrides.transcriptionConfigId}
          valueLabel={overrides.transcriptionConfigId && !transcriptionPicked ? overrides.transcriptionConfigId : undefined}
          options={transcriptionOptions}
          onSelect={value => applyPatch({ transcriptionConfigId: value })}
        />
        {overrides.transcriptionConfigId && !transcriptionPicked ? (
          <FieldHint style={styles.overrideWarn}>
            {t('character.overrides.missing', { id: overrides.transcriptionConfigId })}
          </FieldHint>
        ) : null}
      </View>

      {saveFailed ? (
        <FieldHint style={styles.overrideWarn}>{t('character.overrides.saveFailed')}</FieldHint>
      ) : null}
    </CollapsibleSection>
  );
}
