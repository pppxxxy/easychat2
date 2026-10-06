import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from './network/api.js';
import { buildSystemPrompt } from './character/cardParser.js';
import { buildRequestMessages } from './prompt/chatPipeline.js';
import { readImageDataUri } from './chat/attachments.js';
import { NEAR_BOTTOM_THRESHOLD } from './chat/chatConstants.js';
import { useApp } from './context/AppContext.js';
import CardForgeEditor from './CardForgeEditor.js';
import {
  appendTranscript,
  buildEditPrompt,
  buildGeneratePrompt,
  buildImageCardPrompt,
  createForgeState,
  currentQuestion,
  draftToCharacterPatch,
  FIELD_ASSIST_SYSTEM,
  hasCardContent,
  mergeDraft,
  parseCardPatch,
  recordAnswer,
  summarizeAnswers,
} from './cardForge/forge.js';
import { promoteForgeImageToAvatar, deleteForgeDraftImages, deleteForgeImage } from './cardForge/media.js';
import { getLocalModelMediaCapabilities } from './localModel/modelState.js';
import {
  clearCardForge,
  getActiveLocalModel,
  getActiveModel,
  capabilitiesForModel,
  getApiConfigs,
  getCardForgeStatus,
  getLocalModelSettings,
  saveCardForge,
} from './storage.js';
import { AIGC_META_FIELD, buildAigcMeta, findIpKeywords, ipKeywordNotice } from './aigc/attribution.js';
import { maskSecrets } from './storage/secrets.js';
import { Chip, PrimaryButton, TextField } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const FORGE_SYSTEM = '你是中文角色卡撰写与编辑助手，严格遵守输出格式要求，只输出要求的 JSON。';

export default function CardForgeScreen({ active = true, refreshKey = 0 }) {
  const { theme, fonts, tokens } = useTheme();
  const { addCharacter, ensureCharacterSession } = useApp();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [state, setState] = useState(null);
  const [input, setInput] = useState('');
  const [freeText, setFreeText] = useState('');
  const [freeQuestionId, setFreeQuestionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // 当前来源是否有识图能力：决定编辑器里是否展示「按图片生成角色」按钮。
  // 只影响按钮可见性，真正发送前 imageToCard 会再判一次（能力可能在期间被改）。
  const [visionAvailable, setVisionAvailable] = useState(false);
  const importingRef = useRef(false);
  const busyRef = useRef(false);
  const loadErrorRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const stateRef = useRef(null);
  const scrollRef = useRef(null);
  // 自动滚动策略（与聊天页一致）：只有贴着底部时才跟随新内容，用户主动发送则强制
  // 跟随；否则翻看历史时，任何新写入都会把列表硬拽回底部。
  const atBottomRef = useRef(true);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const requestControllerRef = useRef(null);
  const requestTokenRef = useRef(0);
  activeRef.current = active;
  stateRef.current = state;

  const handleScroll = useCallback(({ nativeEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  }, []);

  const applyState = useCallback(next => {
    stateRef.current = next;
    setState(next);
  }, []);

  const update = useCallback(next => {
    if (loadErrorRef.current) return Promise.resolve(false);
    draftRevisionRef.current += 1;
    applyState(next);
    return saveCardForge(next).catch(() => {
      if (mountedRef.current) {
        Alert.alert(t('forge.screen.alert.draftSaveFailed.title'), t('forge.screen.alert.draftSaveFailed.body'));
      }
      return false;
    });
  }, [applyState, t]);

  const isRequestCurrent = useCallback((token, controller) => (
    mountedRef.current
    && activeRef.current
    && requestTokenRef.current === token
    && requestControllerRef.current === controller
    && !controller.signal.aborted
  ), []);

  useEffect(() => {
    if (active) return;
    requestTokenRef.current += 1;
    const controller = requestControllerRef.current;
    requestControllerRef.current = null;
    controller?.abort();
    importingRef.current = false;
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, [active]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestTokenRef.current += 1;
      const controller = requestControllerRef.current;
       requestControllerRef.current = null;
       controller?.abort();
       busyRef.current = false;
     };
  }, []);

  // 每次切到「制卡」都从存储重读：角色页的「导入到制卡」会改写存储草稿，
  // 而扩展页的各个模块是一直挂载的，不回读就会看到旧内容。
  // refreshKey 由角色页的导入导航带入（params.ts）：即使用户已经停在「制卡」
  // 分段（active 仍为 true），也能触发重读，避免旧草稿覆盖刚导入的内容。
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const revisionAtStart = draftRevisionRef.current;
    getCardForgeStatus()
.then(result => {
          if (cancelled || revisionAtStart !== draftRevisionRef.current) return;
         if (result.status === 'corrupt') {
           loadErrorRef.current = true;
           applyState(createForgeState());
           Alert.alert(t('forge.screen.alert.draftLoadFailed.title'), t('forge.screen.alert.draftLoadFailed.bodyCorrupt'));
           return;
         }
         loadErrorRef.current = false;
         applyState(result.state || createForgeState());
       })
      .catch(() => {
        if (cancelled || revisionAtStart !== draftRevisionRef.current) return;
         loadErrorRef.current = true;
         applyState(createForgeState());
         Alert.alert(t('forge.screen.alert.draftLoadFailed.title'), t('forge.screen.alert.draftLoadFailed.bodyRetry'));
       });

    return () => {
      cancelled = true;
    };
  }, [active, refreshKey, applyState]);

  const askModel = useCallback(async (prompt, signal) => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const raw = await sendChatMessage([
      { role: 'system', content: FORGE_SYSTEM },
      { role: 'user', content: prompt },
    ], {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
    });
    return parseCardPatch(raw);
  }, []);

  // 单字段辅助生成：编辑器组装好的提示词直接发模型，返回原始文本
  //（不经过 parseCardPatch——这不是 JSON 协议，而是单字段纯文本改写）。
  const sendAssistPrompt = useCallback(async (prompt, signal) => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const raw = await sendChatMessage([
      { role: 'system', content: FIELD_ASSIST_SYSTEM },
      { role: 'user', content: prompt },
    ], {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
    });
    // 空回复会被 api 层替换成占位文案，直接写回会把「没有收到回复。」当成模型内容
    // 塞进字段/标签。这里按生成失败抛出，让编辑器统一提示重试。
    const text = String(raw == null ? '' : raw).trim();
    if (!text || text === EMPTY_REPLY_TEXT) {
      throw new Error(t('forge.screen.error.emptyAiReply'));
    }
    return raw;
  }, [t]);

  // 制卡预览的模拟对话：把当前草稿组装成角色结构，走真实聊天管道请求模型。
  // 纯内存测试——不写会话、不落草稿、不影响角色库。
  const simulateChat = useCallback(async ({ draft: source, historyMessages, userText, signal }) => {
    const draft = source && typeof source === 'object' ? source : {};
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const composedPrompt = buildSystemPrompt({
      description: draft.description,
      personality: draft.personality,
      scenario: draft.scenario,
      systemPrompt: draft.systemPrompt || '',
      postHistoryInstructions: draft.postHistoryInstructions,
    });
    const character = draftToCharacterPatch(draft, { composedPrompt });
    const messages = buildRequestMessages({ character, historyMessages, userText });
    return sendChatMessage(messages, {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
    });
  }, []);

  // 与 askModel 同源的模型选择：aigcMeta 里记录实际使用的模型名。
  // 必须用 storage.getActiveModel 的同一口径（activeModel → models[0] → model），
  // 否则实际请求的模型与记录进 aigcMeta 的模型名会对不上。
  const activeForgeModel = useCallback(async () => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    return getActiveModel(current);
  }, []);

  // 当前来源是否具备识图能力：在线 supportsVision 或本地模型多模态（与聊天附件、
  // 看屏幕同一口径）。制卡「按图片生成」需要它来决定是否把图片真的发给模型。
  const activeForgeVision = useCallback(async () => {
    const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
      getApiConfigs(),
      getLocalModelSettings().catch(() => null),
      getActiveLocalModel().catch(() => null),
    ]);
    const current = configs.find(item => item.id === activeId) || configs[0];
    const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
    // 能力按当前模型解析（同一配置下每个模型一套能力）。
    return capabilitiesForModel(current, current ? getActiveModel(current) : '').supportsVision === true
      || localMedia.vision;
  }, []);

  // 打开编辑器前刷新识图能力（能力可能在设置里改过；同聊天附件菜单的做法）。
  const openEditor = useCallback(() => {
    if (busyRef.current) return;
    setEditorOpen(true);
    activeForgeVision()
      .then(value => { if (mountedRef.current) setVisionAvailable(value); })
      .catch(() => {});
  }, [activeForgeVision]);

  // 「按图片生成角色」：把草稿里选的图作为识图输入发给当前模型，读图后写回整卡字段。
  // 与「辅助生成」同源的配置守卫与取消语义；无识图能力时明确拒绝而不是发纯文字。
  const imageToCard = useCallback(async ({ uri, hint, hasAvatar, hasBg, signal }) => {
    const source = String(uri || '');
    if (!source) throw new Error(t('forge.screen.error.invalidImagePath'));
    const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
      getApiConfigs(),
      getLocalModelSettings().catch(() => null),
      getActiveLocalModel().catch(() => null),
    ]);
    const current = configs.find(item => item.id === activeId) || configs[0];
    const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
    const vision = capabilitiesForModel(current, current ? getActiveModel(current) : '').supportsVision === true
      || localMedia.vision;
    if (!vision) {
      throw new Error(t('forge.screen.error.visionUnsupported'));
    }
    const dataUri = await readImageDataUri(source);
    if (!dataUri) throw new Error(t('forge.screen.error.readImageFailed'));
    const prompt = buildImageCardPrompt({ hint, hasAvatar, hasBg });
    const raw = await sendChatMessage([
      { role: 'system', content: FORGE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ], {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
    });
    const patch = parseCardPatch(raw);
    if (!patch) return null;
    // 草稿的集合字段（世界书/正则/预设）保持原样：按图生成只负责文本字段。
    return patch;
  }, [t]);

  // AI 生成/改写后统一处理：给草稿打生成标识（随卡入库与导出），
  // 并对文本做知名 IP 关键词提示——命中只提醒不阻断，责任约定见免责条款。
  const applyAigcAttribution = useCallback((draft, model) => {
    const stamped = { ...draft, [AIGC_META_FIELD]: buildAigcMeta({ model }) };
    const worldTexts = (Array.isArray(stamped.worldInfo) ? stamped.worldInfo : [])
      .map(entry => `${(entry && entry.comment) || ''} ${(entry && Array.isArray(entry.keys) ? entry.keys.join(' ') : '')} ${(entry && entry.content) || ''}`);
    const hits = findIpKeywords([
      stamped.name, stamped.description, stamped.personality, stamped.scenario,
      stamped.firstMes, stamped.mesExample, ...(Array.isArray(stamped.tags) ? stamped.tags : []),
      ...worldTexts,
    ]);
    if (hits.length > 0 && mountedRef.current) {
      Alert.alert(t('forge.screen.alert.ipNotice.title'), ipKeywordNotice(hits));
    }
    return stamped;
  }, [t]);

  const submitAnswer = useCallback((question, value) => {
    const text = String(value || '').trim();
    if (!text || busy || !question || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert(t('forge.screen.alert.draftResetNeeded.title'), t('forge.screen.alert.draftResetNeeded.bodyEdit'));
      return;
    }
    setFreeQuestionId('');
    setFreeText('');
    update(recordAnswer(stateRef.current, question.id, text));
  }, [busy, update, t]);

  const onPickOption = useCallback((question, option) => {
    if (busy) return;
    if (option.free) {
      setFreeQuestionId(question.id);
      setFreeText('');
      return;
    }
    submitAnswer(question, option.label);
  }, [busy, submitAnswer]);

  const onGenerate = useCallback(() => {
    if (busy || busyRef.current || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert(t('forge.screen.alert.draftResetNeeded.title'), t('forge.screen.alert.draftResetNeeded.bodyGenerate'));
      return;
    }
    const run = async () => {
      if (!activeRef.current || !mountedRef.current || busyRef.current) return;
      busyRef.current = true;
      const token = ++requestTokenRef.current;
      const controller = new AbortController();
      requestControllerRef.current = controller;
      setBusy(true);
      const base = stateRef.current;
      try {
        const patch = await askModel(buildGeneratePrompt(base), controller.signal);
        if (!isRequestCurrent(token, controller)) return;
        if (!patch) {
          await update(appendTranscript(stateRef.current, {
            role: 'note',
            text: t('forge.screen.note.generateNoJson'),
          }));
          return;
        }
        const latest = stateRef.current || base;
        const { draft, changed } = mergeDraft(latest.draft, patch);
        const model = await activeForgeModel();
        const stampedDraft = applyAigcAttribution(draft, model);
        let next = { ...latest, draft: stampedDraft, updatedAt: Date.now() };
        next = appendTranscript(next, {
          role: 'ai',
          text: changed.length > 0
            ? t('forge.screen.note.generated', { fields: changed.join('、') })
            : t('forge.screen.note.generateNoChange'),
        });
        const saved = await update(next);
        if (saved && isRequestCurrent(token, controller)) setEditorOpen(true);
      } catch (error) {
        if (isRequestCurrent(token, controller) && !isCanceledError(error)) {
          Alert.alert(t('forge.screen.alert.generateFailed.title'), maskSecrets((error && error.message) || t('forge.screen.alert.retryLater')));
        }
      } finally {
        if (requestTokenRef.current === token) busyRef.current = false;
        if (isRequestCurrent(token, controller)) {
          requestControllerRef.current = null;
          setBusy(false);
        }
      }
    };
    if (hasCardContent(stateRef.current && stateRef.current.draft)) {
      Alert.alert(t('forge.screen.alert.generateConfirm.title'), t('forge.screen.alert.generateConfirm.body'), [
        { text: t('forge.screen.cancel'), style: 'cancel' },
        { text: t('forge.screen.generate'), onPress: () => { run(); } },
      ]);
      return;
    }
    run();
  }, [activeForgeModel, applyAigcAttribution, askModel, busy, isRequestCurrent, update, t]);

  const onSend = useCallback(async () => {
    const text = String(input || '').trim();
    if (!text || busy || busyRef.current || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert(t('forge.screen.alert.draftResetNeeded.title'), t('forge.screen.alert.draftResetNeeded.bodySend'));
      return;
    }
    atBottomRef.current = true;
    busyRef.current = true;
    const token = ++requestTokenRef.current;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setBusy(true);
    const base = stateRef.current;
    try {
      const transcriptSaved = await update(appendTranscript(base, {
        id: `u-${Date.now()}`,
        role: 'user',
        text,
      }));
      if (!transcriptSaved) return;
      setInput('');
      if (!isRequestCurrent(token, controller)) return;
      const latest = stateRef.current || base;
      const patch = await askModel(buildEditPrompt({
        draft: latest.draft,
        request: text,
        answers: summarizeAnswers(latest),
      }), controller.signal);
      if (!isRequestCurrent(token, controller)) return;
      if (!patch) {
        await update(appendTranscript(stateRef.current, {
          role: 'note',
          text: t('forge.screen.note.editNoPatch'),
        }));
        return;
      }
      const current = stateRef.current;
      const { draft, changed } = mergeDraft(current.draft, patch);
      const model = await activeForgeModel();
      const stampedDraft = applyAigcAttribution(draft, model);
      let next = { ...current, draft: stampedDraft, updatedAt: Date.now() };
      next = appendTranscript(next, {
        role: 'ai',
        text: changed.length > 0
          ? t('forge.screen.note.updated', { fields: changed.join('、') })
          : t('forge.screen.note.editNoChange'),
      });
      await update(next);
    } catch (error) {
      if (isRequestCurrent(token, controller) && !isCanceledError(error)) {
        Alert.alert(t('forge.screen.alert.forgeFailed.title'), maskSecrets((error && error.message) || t('forge.screen.alert.retryLater')));
      }
    } finally {
      if (requestTokenRef.current === token) busyRef.current = false;
      if (isRequestCurrent(token, controller)) {
        requestControllerRef.current = null;
        setBusy(false);
      }
    }
  }, [activeForgeModel, applyAigcAttribution, askModel, busy, input, isRequestCurrent, update, t]);

  const onSaveDraft = useCallback(nextDraft => {
    if (!mountedRef.current || !activeRef.current || busyRef.current) return;
    setEditorOpen(false);
    update({ ...stateRef.current, draft: nextDraft, updatedAt: Date.now() });
  }, [update]);

  const onImport = useCallback(async () => {
    if (busy || busyRef.current || importingRef.current) return;
    const draft = stateRef.current && stateRef.current.draft;
    if (!hasCardContent(draft)) {
      Alert.alert(t('forge.screen.alert.cardEmpty.title'), t('forge.screen.alert.cardEmpty.body'));
      return;
    }
    importingRef.current = true;
    busyRef.current = true;
    const importToken = ++requestTokenRef.current;
    setBusy(true);
    try {
      const composedPrompt = buildSystemPrompt({
        description: draft.description,
        personality: draft.personality,
        scenario: draft.scenario,
        systemPrompt: draft.systemPrompt || '',
        postHistoryInstructions: draft.postHistoryInstructions,
      });
      // 草稿图放 card-forge/（不进孤儿回收扫描），导入时要提升到 avatars/——
      // 新角色随后引用它们，回收器才不会把它们当孤儿删掉。
      const stamp = Date.now();
      const [avatarUri, bgUri] = await Promise.all([
        promoteForgeImageToAvatar(draft.avatarUri, { now: stamp }),
        promoteForgeImageToAvatar(draft.bgUri, { now: stamp + 1 }),
      ]);
      const patch = draftToCharacterPatch(draft, { composedPrompt });
      patch.avatarUri = avatarUri;
      patch.bgUri = bgUri;
       const created = await addCharacter(patch);
       if (!mountedRef.current || !activeRef.current) return;
       // 角色确实建好了，草稿目录里的副本才可以清理（复制与删除分开做，
       // 是为了让落库失败时草稿仍指向存在的文件，界面不会变成破图）。
       await Promise.all([
         deleteForgeImage(draft.avatarUri),
         deleteForgeImage(draft.bgUri),
       ]);
       await ensureCharacterSession(created.id).catch(() => {});
       if (!mountedRef.current || !activeRef.current) return;
       // 草稿里要把路径换成提升后的 avatars/ 路径：草稿目录里的副本已被删除，
       // 留着旧路径再点一次「导入」会去复制不存在的文件而报错。
       const nextState = {
         ...stateRef.current,
         draft: { ...(stateRef.current && stateRef.current.draft), avatarUri, bgUri },
         updatedAt: Date.now(),
       };
       await update(appendTranscript(nextState, {

        role: 'note',
        text: t('forge.screen.note.imported', { name: created.name }),
      }));
      Alert.alert(t('forge.screen.alert.imported.title'), t('forge.screen.alert.imported.body', { name: created.name }));
    } catch (error) {
      Alert.alert(t('forge.screen.alert.importFailed.title'), maskSecrets((error && error.message) || t('forge.screen.alert.importFailed.body')));
    } finally {
      if (requestTokenRef.current === importToken) {
        importingRef.current = false;
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [addCharacter, busy, ensureCharacterSession, update, t]);

  const onReset = useCallback(() => {
    if (busy) return;
    Alert.alert(t('forge.screen.alert.reset.title'), t('forge.screen.alert.reset.body'), [
      { text: t('forge.screen.cancel'), style: 'cancel' },
      {
        text: t('forge.screen.resetConfirm'),
        style: 'destructive',
         onPress: async () => {
           if (!mountedRef.current || !activeRef.current || busyRef.current) return;
           busyRef.current = true;
           setBusy(true);
           const resetToken = ++requestTokenRef.current;
           try {
             await clearCardForge();
             if (!mountedRef.current || !activeRef.current) return;
             loadErrorRef.current = false;
             await update(createForgeState());
             // 草稿图一并清掉：clearCardForge 只删 .json 载荷，图不清理会长期占空间。
             await deleteForgeDraftImages();
             } catch (error) {
               if (mountedRef.current) {
                 Alert.alert(t('forge.screen.alert.clearFailed.title'), t('forge.screen.alert.clearFailed.body'));
               }
             } finally {
               if (requestTokenRef.current === resetToken) {
                 busyRef.current = false;
                 if (mountedRef.current) setBusy(false);
               }
             }
          },

      },
    ]);
  }, [busy, update, t]);

  if (!state) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const question = currentQuestion(state);
  const draft = state.draft || {};
  const draftName = String(draft.name || '').trim();
  const tagLine = Array.isArray(draft.tags) && draft.tags.length > 0 ? ` · ${draft.tags.join('、')}` : '';
  // 生成的高级内容在这里给出可见计数，否则用户不知道世界书 / 正则 / 预设有没有一起生成
  const advancedParts = [
    [Array.isArray(draft.worldInfo) ? draft.worldInfo.length : 0, t('forge.screen.count.world')],
    [Array.isArray(draft.regexScripts) ? draft.regexScripts.length : 0, t('forge.screen.count.regex')],
    [Array.isArray(draft.presets) ? draft.presets.length : 0, t('forge.screen.count.preset')],
  ].filter(item => item[0] > 0).map(item => `${item[1]} ${item[0]}`);
  const advancedLine = advancedParts.length > 0 ? ` · ${advancedParts.join(' / ')}` : '';

  const renderOptions = currentQ => (
    <View style={styles.options}>
      {currentQ.options.map(option => (
        <Chip
          key={option.id}
          label={option.label}
          disabled={busy}
          onPress={() => onPickOption(currentQ, option)}
        />
      ))}
      {freeQuestionId === currentQ.id ? (
        <View style={styles.freeRow}>
          <TextField
            style={styles.freeInput}
            value={freeText}
            onChangeText={setFreeText}
            placeholder={currentQ.freeHint || t('forge.screen.freePlaceholder')}
            autoFocus
          />
          <PrimaryButton
            title={t('forge.screen.confirm')}
            small
            onPress={() => submitAnswer(currentQ, freeText)}
            disabled={busy || !freeText.trim()}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{t('forge.screen.title')}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={openEditor}
            disabled={busy}
            activeOpacity={0.8}
            accessibilityLabel={t('forge.screen.cardA11y')}
          >
            <Ionicons name="id-card-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.actionText}>{t('forge.screen.card')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={onGenerate}
            disabled={busy}
            activeOpacity={0.8}
            accessibilityLabel={t('forge.screen.generateA11y')}
          >
            <Ionicons name="sparkles-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.actionText}>{t('forge.screen.generate')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={onReset}
            disabled={busy}
            activeOpacity={0.8}
            accessibilityLabel={t('forge.screen.resetA11y')}
          >
            <Ionicons name="refresh-outline" size={15} color={theme.colors.textFaint} />
            <Text style={styles.actionText}>{t('forge.screen.reset')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.draftLine} numberOfLines={1}>
        {hasCardContent(draft)
          ? t('forge.screen.draftLine', { name: draftName || t('forge.screen.draftUntitled'), tags: tagLine, advanced: advancedLine })
          : t('forge.screen.draftEmpty')}
      </Text>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (atBottomRef.current && scrollRef.current) scrollRef.current.scrollToEnd({ animated: true });
        }}
      >
        {state.transcript.map(entry => {
          const isUser = entry.role === 'user';
          const isNote = entry.role === 'note';
          const isCurrentQuestion = !!question && entry.questionId === question.id;
          return (
            <View key={entry.id} style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
              <View
                style={[
                  styles.bubble,
                  isUser ? styles.bubbleUser : (isNote ? styles.bubbleNote : styles.bubbleAi),
                ]}
              >
                <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>{entry.text}</Text>
              </View>
              {isCurrentQuestion ? renderOptions(question) : null}
            </View>
          );
        })}
      </ScrollView>

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.busyText}>{t('forge.screen.busy')}</Text>
        </View>
      ) : null}

      <View style={styles.footer}>
        <TextField
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={t('forge.screen.inputPlaceholder')}
          onSubmitEditing={onSend}
          returnKeyType="send"
          editable={!busy}
        />
        <PrimaryButton
          title={t('forge.screen.send')}
          small
          onPress={onSend}
          disabled={busy || !input.trim()}
          style={styles.sendButton}
        />
      </View>

      <View style={styles.importRow}>
        <PrimaryButton
          title={t('forge.screen.import')}
          icon="download-outline"
          onPress={onImport}
          disabled={busy}
        />
      </View>

      <CardForgeEditor
        visible={editorOpen}
        draft={draft}
        onClose={() => setEditorOpen(false)}
        onSave={onSaveDraft}
        onAssistPrompt={sendAssistPrompt}
        onSimulateChat={simulateChat}
        onImageGenerate={imageToCard}
        visionAvailable={visionAvailable}
      />
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 6,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(20), fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  actionDisabled: { opacity: tokens.opacity.disabled },
  actionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  draftLine: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 12 },
  bubbleRow: { alignItems: 'flex-start', marginBottom: 10 },
  bubbleRowUser: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '92%',
    borderRadius: tokens.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  bubbleAi: { backgroundColor: theme.colors.surface },
  bubbleUser: { backgroundColor: theme.colors.primary },
  bubbleNote: { backgroundColor: theme.colors.surfaceAlt, borderStyle: 'dashed' },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(20) },
  bubbleTextUser: { color: theme.colors.primaryContrast },
  options: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, maxWidth: '96%' },
  freeRow: { flexDirection: 'row', alignItems: 'center', width: '100%', marginTop: 2 },
  freeInput: { flex: 1, marginRight: 8 },
  busyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 6 },
  busyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  input: { flex: 1, marginRight: 8 },
  sendButton: { minWidth: 72 },
  importRow: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 },
});
