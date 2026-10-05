import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
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

import {
  FIELD_LABELS,
  FORGE_FIELDS,
  MAX_FORGE_TAG_COUNT,
  buildEntryAssistPrompt,
  buildFieldAssistPrompt,
  buildTagsAssistPrompt,
  createForgeDraft,
  mergeEntryAssistPatch,
  parseEntryAssistPatch,
  parseFieldAssistText,
} from './cardForge/forge.js';
import { deleteForgeImage, pickForgeImage } from './cardForge/media.js';
import { createRegexScript, createWorldEntry } from './character/cardParser.js';
import CardPreviewModal from './CardPreviewModal.js';
import { makeCharacterPresetId } from './character/characterPresets.js';
import { AIGC_META_FIELD, AIGC_NOTICE_TEXT, buildAigcMeta, isValidAigcMeta } from './aigc/attribution.js';
import { isCanceledError } from './network/api.js';
import { maskSecrets } from './storage/secrets.js';
import { FieldGroup, PrimaryButton, SecondaryButton, TextField } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const MULTILINE_FIELDS = new Set([
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'creatorNotes',
  'postHistoryInstructions',
]);

// 字段 placeholder 文案走 i18n：在组件内按当前语言构建（见 CardForgeEditor 内 placeholders）。
function buildPlaceholders(t) {
  return {
    name: t('forge.placeholder.name'),
    description: t('forge.placeholder.description'),
    personality: t('forge.placeholder.personality'),
    scenario: t('forge.placeholder.scenario'),
    firstMes: t('forge.placeholder.firstMes'),
    mesExample: t('forge.placeholder.mesExample'),
    creatorNotes: t('forge.placeholder.creatorNotes'),
    postHistoryInstructions: t('forge.placeholder.postHistoryInstructions'),
  };
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[、,，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function AssistButton({ onPress, label }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={styles.assistButton}
      onPress={onPress}
      activeOpacity={0.8}
      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={t('forge.assist.a11y', { label })}
    >
      <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
      <Text style={styles.assistButtonText}>{t('forge.assist.button')}</Text>
    </TouchableOpacity>
  );
}

export default function CardForgeEditor({ visible, draft, onClose, onSave, onAssistPrompt, onSimulateChat, onImageGenerate, visionAvailable = false }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const placeholders = useMemo(() => buildPlaceholders(t), [t]);
  const [form, setForm] = useState(() => ({ ...createForgeDraft(), ...(draft || {}) }));
  const [tagText, setTagText] = useState('');
  const [assistTarget, setAssistTarget] = useState(null);
  const [assistText, setAssistText] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageGenTarget, setImageGenTarget] = useState(null);
  const [imageGenHint, setImageGenHint] = useState('');
  const [imageGenBusy, setImageGenBusy] = useState(false);
  const imageAbortRef = useRef(null);
  // 集合条目默认折叠，点标题展开（可同时展开多条）；新增条目自动展开。
  const [expandedEntries, setExpandedEntries] = useState(() => new Set());
  const wasVisibleRef = useRef(false);
  const assistAbortRef = useRef(null);
  // 选图守卫：mountedRef 防写到已卸载组件、editorSessionRef 防迟到结果写进新一轮、
  // imageOperationRef 按操作序号丢弃过期结果、imageBusyRef 做同 tick 重入闸门。
  const mountedRef = useRef(true);
  const editorSessionRef = useRef(0);
  const imageOperationRef = useRef(0);
  const imageBusyRef = useRef(false);
  // 预览要拿"当前表单"（含未保存的改动），用 ref 避免回调里读到旧快照。
  const formRef = useRef(form);
  formRef.current = form;

  // 只在"打开的那一刻"用最新草稿填充：弹窗开着时草稿若被 AI 回复更新，
  // 不能把用户正在输入的内容冲掉。
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (wasVisible === visible) return;
    // 开与关都算一轮结束：关掉弹窗意味着本轮未保存的改动被丢弃（只有 onSave 才回写
    // 草稿），此时还在系统选图器里挂着的结果回来必须作废——否则它会写进一个已经
    // 隐藏的表单（用户再打开时又被草稿重置丢掉），草稿目录里那份副本也永远没人引用。
    editorSessionRef.current += 1;
    imageOperationRef.current += 1;
    imageBusyRef.current = false;
    setImageBusy(false);
    if (!visible) return;
    const next = { ...createForgeDraft(), ...(draft || {}) };
    setForm(next);
    setTagText(Array.isArray(next.tags) ? next.tags.join('、') : '');
    setExpandedEntries(new Set());
  }, [draft, visible]);

  // 卸载标记：迟到的选图结果不得 setState 到已卸载组件。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      editorSessionRef.current += 1;
    };
  }, []);

  // 卸载时中止挂着的辅助生成/按图生成请求，避免写回已卸载的表单。
  useEffect(() => () => {
    if (assistAbortRef.current) assistAbortRef.current.abort();
    if (imageAbortRef.current) imageAbortRef.current.abort();
  }, []);

  // ---- 头像 / 背景图 ----
  // 选图走的是系统界面：用户可能在选图器开着时关掉弹窗，或同 tick 连点两次。
  // 对齐 CharacterScreen.pickImage 的成熟模式：挂载标记 + 会话号 + 操作序号三重守卫，
  // 迟到的结果既不写已卸载的组件，也不写已经关掉又重新打开的旧会话。
  // 闸门用 ref 而非 imageBusy 闭包布尔：setState 是异步的，同一 tick 的两次点击
  // 读到的还是旧值，会开出两个选择器。
  const pickImage = async key => {
    if (imageBusyRef.current) return;
    imageBusyRef.current = true;
    setImageBusy(true);
    const operation = ++imageOperationRef.current;
    const session = editorSessionRef.current;
    const isCurrent = () => (
      mountedRef.current
      && imageOperationRef.current === operation
      && editorSessionRef.current === session
    );
    try {
      const previous = String(formRef.current[key] || '');
      const uri = await pickForgeImage({ key });
      if (!isCurrent()) {
        // 结果来晚了（弹窗已关/又开了新一轮）：刚写进草稿目录的副本已无人引用，
        // 就地清掉，避免留下永远不显示的垃圾文件。
        if (uri) await deleteForgeImage(uri).catch(() => {});
        return;
      }
      if (!uri) return;
      // 换了新图就删旧草稿副本（deleteForgeImage 只删草稿目录内的文件）。
      if (previous && previous !== uri) await deleteForgeImage(previous);
      setForm(current => ({ ...current, [key]: uri }));
    } catch (error) {
      if (isCurrent()) Alert.alert(t('forge.alert.readImageFailed.title'), t('forge.alert.readImageFailed.body'));
    } finally {
      if (imageOperationRef.current === operation) {
        imageBusyRef.current = false;
        if (mountedRef.current) setImageBusy(false);
      }
    }
  };

  const clearImage = key => {
    const previous = String(form[key] || '');
    if (previous) deleteForgeImage(previous).catch(() => {});
    setForm(current => ({ ...current, [key]: '' }));
  };

  // ---- 按图片生成角色卡 ----
  const openImageGenerate = target => {
    if (imageGenBusy) return;
    const source = target === 'bg' ? form.bgUri : form.avatarUri;
    if (!String(source || '').trim()) {
      Alert.alert(t('forge.alert.pickImageFirst.title'), target === 'bg' ? t('forge.alert.pickImageFirst.bodyBg') : t('forge.alert.pickImageFirst.bodyAvatar'));
      return;
    }
    setImageGenTarget(target);
    setImageGenHint('');
  };

  const closeImageGenerate = () => {
    if (imageAbortRef.current) {
      imageAbortRef.current.abort();
      imageAbortRef.current = null;
    }
    setImageGenBusy(false);
    setImageGenTarget(null);
    setImageGenHint('');
  };

  const submitImageGenerate = async () => {
    const target = imageGenTarget;
    if (!target) return;
    if (typeof onImageGenerate !== 'function') {
      Alert.alert(t('forge.alert.unavailable.title'), t('forge.alert.unavailable.body'));
      return;
    }
    const controller = new AbortController();
    imageAbortRef.current = controller;
    setImageGenBusy(true);
    try {
      const uri = target === 'bg' ? form.bgUri : form.avatarUri;
      const patch = await onImageGenerate({
        uri,
        hint: imageGenHint.trim(),
        hasAvatar: target === 'avatar',
        hasBg: target === 'bg',
        signal: controller.signal,
      });
      if (!patch) {
        Alert.alert(t('forge.alert.generateFailed.title'), t('forge.alert.generateFailed.bodyInvalidCard'));
        return;
      }
      // 图片字段由这里填（模型的 JSON 里不含图片路径）。
      const images = { avatarUri: form.avatarUri || '', bgUri: form.bgUri || '' };
      setForm(current => ({
        ...current,
        ...patch,
        ...images,
        [AIGC_META_FIELD]: buildAigcMeta({ source: 'easychat2-image-to-card' }),
      }));
      closeImageGenerate();
    } catch (error) {
      if (isCanceledError(error)) return;
      Alert.alert(t('forge.alert.generateFailed.title'), maskSecrets((error && error.message) || t('forge.alert.generateFailed.bodyRetry')));
    } finally {
      if (imageAbortRef.current === controller) {
        imageAbortRef.current = null;
        setImageGenBusy(false);
      }
    }
  };

  const save = () => {
    const tags = tagText
      .split(/[、,，]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, MAX_FORGE_TAG_COUNT);
    onSave({ ...form, tags });
  };

  // 预览的每一轮都把当前表单当作草稿交给上层，由上层组装角色并请求模型。
  const handlePreviewTurn = useCallback((historyMessages, userText, signal) => {
    if (typeof onSimulateChat !== 'function') {
      return Promise.reject(new Error(t('forge.error.noModel')));
    }
    return onSimulateChat({ draft: formRef.current, historyMessages, userText, signal });
  }, [onSimulateChat]);

  // ---- 集合编辑：世界书 / 正则 / 预设 ----
  const patchList = (key, updater) => {
    setForm(current => ({ ...current, [key]: updater(Array.isArray(current[key]) ? current[key] : []) }));
  };

  const updateEntry = (key, index, patch) => {
    patchList(key, list => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeEntry = (key, index) => {
    patchList(key, list => list.filter((_, i) => i !== index));
  };

  // 折叠控制：条目 key 用列表名 + 稳定 id（无 id 时退回序号）
  const entryKeyOf = (listKey, entry, index) => `${listKey}:${(entry && entry.id) || index}`;
  const toggleEntry = entryKey => setExpandedEntries(current => {
    const next = new Set(current);
    if (next.has(entryKey)) next.delete(entryKey); else next.add(entryKey);
    return next;
  });
  const expandEntry = entryKey => setExpandedEntries(current => new Set(current).add(entryKey));

  const worldInfo = Array.isArray(form.worldInfo) ? form.worldInfo : [];
  const regexScripts = Array.isArray(form.regexScripts) ? form.regexScripts : [];
  const presets = Array.isArray(form.presets) ? form.presets : [];

  const addWorldEntry = () => {
    const id = `entry-${Date.now().toString(36)}`;
    patchList('worldInfo', list => [...list, createWorldEntry({
      id,
      comment: t('forge.newEntry.worldInfo', { n: list.length + 1 }),
    })]);
    expandEntry(`worldInfo:${id}`);
  };

  const addRegexScript = () => {
    const id = `regex-${Date.now().toString(36)}`;
    patchList('regexScripts', list => [...list, createRegexScript({
      id,
      name: t('forge.newEntry.regex', { n: list.length + 1 }),
    })]);
    expandEntry(`regexScripts:${id}`);
  };

  const addPreset = () => {
    const id = makeCharacterPresetId(presets);
    patchList('presets', list => [...list, {
      id,
      name: t('forge.newEntry.preset', { n: list.length + 1 }),
      prompt: '',
      enabled: true,
    }]);
    expandEntry(`presets:${id}`);
  };

  // ---- 辅助生成：文本字段 / 标签 / 集合条目 ----
  const openAssist = target => {
    if (assistBusy) return;
    setAssistTarget(target);
    setAssistText('');
  };

  const closeAssist = () => {
    if (assistAbortRef.current) {
      assistAbortRef.current.abort();
      assistAbortRef.current = null;
    }
    setAssistBusy(false);
    setAssistTarget(null);
    setAssistText('');
  };

  const currentAssistEntry = () => {
    const target = assistTarget;
    if (!target || target.kind !== 'entry') return null;
    const list = Array.isArray(form[target.listKey]) ? form[target.listKey] : [];
    return list[target.index] || null;
  };

  const applyAigcStamp = current => ({
    ...current,
    // 字段/标签/条目的 AI 改写同样是生成内容：更新标识（source 区分整卡生成与辅助改写）
    [AIGC_META_FIELD]: buildAigcMeta({ source: 'easychat2-field-assist' }),
  });

  const submitAssist = async () => {
    const target = assistTarget;
    const request = assistText.trim();
    if (!target || !request) {
      Alert.alert(t('forge.alert.describeFirst.title'), t('forge.alert.describeFirst.body'));
      return;
    }
    if (typeof onAssistPrompt !== 'function') {
      Alert.alert(t('forge.alert.unavailable.title'), t('forge.alert.unavailable.body'));
      return;
    }
    const controller = new AbortController();
    assistAbortRef.current = controller;
    setAssistBusy(true);
    try {
      // 按目标组装提示词
      let prompt;
      if (target.kind === 'field') {
        prompt = buildFieldAssistPrompt({
          fieldLabel: target.label,
          currentValue: form[target.key],
          request,
        });
      } else if (target.kind === 'tags') {
        prompt = buildTagsAssistPrompt({ currentTags: splitKeywords(tagText), request });
      } else {
        prompt = buildEntryAssistPrompt({
          kind: target.listKey,
          currentEntry: currentAssistEntry() || {},
          request,
        });
      }
      const raw = await onAssistPrompt(prompt, controller.signal);

      // 集合条目：JSON 协议，按白名单字段合并
      if (target.kind === 'entry') {
        const patch = parseEntryAssistPatch(raw);
        if (!patch) {
          Alert.alert(t('forge.alert.generateFailed.title'), t('forge.alert.generateFailed.bodyInvalidJson'));
          return;
        }
        const listKey = target.listKey;
        const index = target.index;
        setForm(current => {
          const list = Array.isArray(current[listKey]) ? current[listKey] : [];
          const merged = mergeEntryAssistPatch(list[index], listKey, patch);
          return applyAigcStamp({
            ...current,
            [listKey]: list.map((item, i) => (i === index ? merged : item)),
          });
        });
        closeAssist();
        return;
      }

      // 文本字段与标签：纯文本协议
      const text = parseFieldAssistText(raw);
      if (text === null) {
        Alert.alert(t('forge.alert.generateFailed.title'), t('forge.alert.generateFailed.bodyInvalidContent'));
        return;
      }
      if (target.kind === 'tags') {
        const list = text
          .split(/[、,，]+/)
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, MAX_FORGE_TAG_COUNT);
        if (list.length === 0) {
          Alert.alert(t('forge.alert.generateFailed.title'), t('forge.alert.generateFailed.bodyInvalidTags'));
          return;
        }
        setTagText(list.join('、'));
        setForm(current => applyAigcStamp({ ...current, tags: list }));
      } else {
        const appliedKey = target.key;
        setForm(current => applyAigcStamp({ ...current, [appliedKey]: text }));
      }
      closeAssist();
    } catch (error) {
      if (isCanceledError(error)) return;
      Alert.alert(t('forge.alert.generateFailed.title'), maskSecrets((error && error.message) || t('forge.alert.generateFailed.bodyRetry')));
    } finally {
      if (assistAbortRef.current === controller) {
        assistAbortRef.current = null;
        setAssistBusy(false);
      }
    }
  };

  // 正则条目的辅助生成风险提示：AI 生成的正则常不可用/有隐患，弹窗里明确告知。
  const isRegexAssist = !!assistTarget
    && assistTarget.kind === 'entry'
    && assistTarget.listKey === 'regexScripts';

  const assistLabel = (() => {
    const target = assistTarget;
    if (!target) return '';
    if (target.kind === 'field') return FIELD_LABELS[target.key] || target.label;
    if (target.kind === 'tags') return t('forge.assist.tagsLabel');
    return target.label || t('forge.assist.entryFallback');
  })();

  const assistPreview = (() => {
    const target = assistTarget;
    if (!target) return '';
    if (target.kind === 'field') return String(form[target.key] || '');
    if (target.kind === 'tags') return tagText;
    const entry = currentAssistEntry() || {};
    if (target.listKey === 'worldInfo') {
      return [entry.comment, Array.isArray(entry.keys) ? entry.keys.join('、') : '', entry.content]
        .filter(Boolean).join('　');
    }
    if (target.listKey === 'regexScripts') {
      return [entry.name, entry.findRegex ? `${entry.findRegex} → ${entry.replaceString || ''}` : '']
        .filter(Boolean).join('　');
    }
    return [entry.name, entry.prompt].filter(Boolean).join('　');
  })();

  // 预览用与保存同源的标签拆分，避免预览里显示的是尚未同步的旧标签。
  const previewDraft = useMemo(() => ({
    ...form,
    tags: splitKeywords(tagText).slice(0, MAX_FORGE_TAG_COUNT),
  }), [form, tagText]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('forge.title')}</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.previewAction}
              onPress={() => setPreviewOpen(true)}
              hitSlop={8}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('forge.preview.a11y')}
            >
              <Ionicons name="eye-outline" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.previewActionText}>{t('forge.preview.button')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('forge.close.a11y')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>{t('forge.hint')}</Text>
          <Text style={styles.aigcNotice}>{t('forge.aigc.notice', { notice: AIGC_NOTICE_TEXT })}</Text>
          {isValidAigcMeta(form[AIGC_META_FIELD]) ? (
            <Text style={styles.aigcBadge}>{t('forge.aigc.badge', { code: form[AIGC_META_FIELD].contentCode || '' })}</Text>
          ) : null}
          <FieldGroup
            label={t('forge.avatar.label')}
            hint={t('forge.avatar.hint')}
          >
            <View style={styles.imageRow}>
              {form.avatarUri ? (
                <Image source={{ uri: String(form.avatarUri) }} style={styles.avatarPreview} />
              ) : (
                <View style={[styles.avatarPreview, styles.imagePlaceholder]}>
                  <Ionicons name="person-outline" size={18} color={theme.colors.textFaint} />
                </View>
              )}
              <View style={styles.imageButtons}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => pickImage('avatarUri')}
                  disabled={imageBusy}
                  activeOpacity={0.8}
                >
                  <Text style={styles.smallButtonText}>{form.avatarUri ? t('forge.image.change') : t('forge.image.pickAvatar')}</Text>
                </TouchableOpacity>
                {form.avatarUri ? (
                  <TouchableOpacity style={styles.smallButton} onPress={() => clearImage('avatarUri')} hitSlop={6} activeOpacity={0.8}>
                    <Text style={styles.removeText}>{t('forge.image.clear')}</Text>
                  </TouchableOpacity>
                ) : null}
                {visionAvailable ? (
                  <TouchableOpacity
                    style={styles.imageGenButton}
                    onPress={() => openImageGenerate('avatar')}
                    disabled={!form.avatarUri || imageGenBusy}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('forge.imageGen.avatarA11y')}
                  >
                    <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
                    <Text style={styles.imageGenText}>{t('forge.imageGen.avatarButton')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </FieldGroup>
          <FieldGroup
            label={t('forge.bg.label')}
            hint={t('forge.bg.hint')}
          >
            <View style={styles.imageRow}>
              {form.bgUri ? (
                <Image source={{ uri: String(form.bgUri) }} style={styles.bgPreview} />
              ) : (
                <View style={[styles.bgPreview, styles.imagePlaceholder]}>
                  <Ionicons name="image-outline" size={18} color={theme.colors.textFaint} />
                </View>
              )}
              <View style={styles.imageButtons}>
                <TouchableOpacity
                  style={styles.smallButton}
                  onPress={() => pickImage('bgUri')}
                  disabled={imageBusy}
                  activeOpacity={0.8}
                >
                  <Text style={styles.smallButtonText}>{form.bgUri ? t('forge.image.change') : t('forge.image.pickBg')}</Text>
                </TouchableOpacity>
                {form.bgUri ? (
                  <TouchableOpacity style={styles.smallButton} onPress={() => clearImage('bgUri')} hitSlop={6} activeOpacity={0.8}>
                    <Text style={styles.removeText}>{t('forge.image.clear')}</Text>
                  </TouchableOpacity>
                ) : null}
                {visionAvailable ? (
                  <TouchableOpacity
                    style={styles.imageGenButton}
                    onPress={() => openImageGenerate('bg')}
                    disabled={!form.bgUri || imageGenBusy}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('forge.imageGen.bgA11y')}
                  >
                    <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
                    <Text style={styles.imageGenText}>{t('forge.imageGen.bgButton')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </FieldGroup>
          {FORGE_FIELDS.map(key => (
            <FieldGroup
              key={key}
              label={FIELD_LABELS[key] || key}
              action={<AssistButton label={FIELD_LABELS[key] || key} onPress={() => openAssist({ kind: 'field', key, label: FIELD_LABELS[key] || key })} />}
            >
              <TextField
                value={String(form[key] || '')}
                onChangeText={value => setForm(current => ({ ...current, [key]: value }))}
                placeholder={placeholders[key] || ''}
                multiline={MULTILINE_FIELDS.has(key)}
              />
            </FieldGroup>
          ))}
          <FieldGroup
            label={t('forge.systemPrompt.label')}
            hint={t('forge.systemPrompt.hint')}
            action={<AssistButton label={t('forge.systemPrompt.label')} onPress={() => openAssist({ kind: 'field', key: 'systemPrompt', label: t('forge.systemPrompt.label') })} />}
          >
            <TextField
              value={String(form.systemPrompt || '')}
              onChangeText={value => setForm(current => ({ ...current, systemPrompt: value }))}
              placeholder={t('forge.systemPrompt.placeholder')}
              multiline
            />
          </FieldGroup>
          <FieldGroup
            label={t('forge.tags.label')}
            hint={t('forge.tags.hint', { max: MAX_FORGE_TAG_COUNT })}
            action={<AssistButton label={t('forge.tags.label')} onPress={() => openAssist({ kind: 'tags', label: t('forge.tags.label') })} />}
          >
            <TextField value={tagText} onChangeText={setTagText} placeholder={t('forge.tags.placeholder')} />
          </FieldGroup>

          <FieldGroup label={t('forge.world.groupLabel')} hint={t('forge.world.groupHint')}>
            {worldInfo.length === 0 ? (
              <Text style={styles.emptyText}>{t('forge.world.empty')}</Text>
            ) : worldInfo.map((entry, index) => {
              const entryKey = entryKeyOf('worldInfo', entry, index);
              const expanded = expandedEntries.has(entryKey);
              const summary = [
                Array.isArray(entry.keys) && entry.keys.length ? t('forge.world.keywords', { keys: entry.keys.join('、') }) : '',
                String(entry.content || '').replace(/\s+/g, ' ').trim(),
              ].filter(Boolean).join('　');
              return (
                <View key={entryKey} style={styles.entryCard}>
                  <View style={styles.entryHeader}>
                    <TouchableOpacity
                      style={styles.entryToggle}
                      onPress={() => toggleEntry(entryKey)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t('forge.world.expandA11y', { n: index + 1 })}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{entry.comment || t('forge.world.entryFallback', { n: index + 1 })}</Text>
                      {entry.enabled === false ? <Text style={styles.entryDisabled}>{t('forge.disabled')}</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('worldInfo', index)} hitSlop={8} accessibilityLabel={t('forge.world.deleteA11y')}>
                      <Text style={styles.removeText}>{t('forge.delete')}</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label={t('forge.world.groupLabel')}
                          onPress={() => openAssist({ kind: 'entry', listKey: 'worldInfo', index, label: t('forge.world.groupLabel') })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(entry.comment || '')}
                        onChangeText={comment => updateEntry('worldInfo', index, { comment })}
                        placeholder={t('forge.world.namePlaceholder')}
                      />
                      <TextField
                        style={styles.entryInput}
                        value={(Array.isArray(entry.keys) ? entry.keys : []).join(', ')}
                        onChangeText={text => updateEntry('worldInfo', index, { keys: splitKeywords(text) })}
                        placeholder={t('forge.world.keysPlaceholder')}
                      />
                      <TextField
                        style={styles.entryContent}
                        value={String(entry.content || '')}
                        onChangeText={content => updateEntry('worldInfo', index, { content })}
                        placeholder={t('forge.world.contentPlaceholder')}
                        multiline
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.world.constantLabel')}</Text>
                        <Switch
                          value={entry.constant === true}
                          onValueChange={constant => updateEntry('worldInfo', index, { constant })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.enabledLabel')}</Text>
                        <Switch
                          value={entry.enabled !== false}
                          onValueChange={enabled => updateEntry('worldInfo', index, { enabled })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.entrySummary} numberOfLines={2}>{summary || t('forge.emptyContent')}</Text>
                  )}
                </View>
              );
            })}
            <SecondaryButton title={t('forge.world.add')} onPress={addWorldEntry} small />
          </FieldGroup>

          <FieldGroup label={t('forge.regex.groupLabel')} hint={t('forge.regex.groupHint')}>
            {regexScripts.length === 0 ? (
              <Text style={styles.emptyText}>{t('forge.regex.empty')}</Text>
            ) : regexScripts.map((script, index) => {
              const entryKey = entryKeyOf('regexScripts', script, index);
              const expanded = expandedEntries.has(entryKey);
              const summary = String(script.findRegex || '').trim()
                ? t('forge.regex.summary', { find: script.findRegex, replace: script.replaceString || t('forge.regex.emptyValue') })
                : t('forge.regex.unset');
              return (
                <View key={entryKey} style={styles.entryCard}>
                  <View style={styles.entryHeader}>
                    <TouchableOpacity
                      style={styles.entryToggle}
                      onPress={() => toggleEntry(entryKey)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t('forge.regex.expandA11y', { n: index + 1 })}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{script.name || t('forge.regex.entryFallback', { n: index + 1 })}</Text>
                      {script.enabled === false ? <Text style={styles.entryDisabled}>{t('forge.disabled')}</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('regexScripts', index)} hitSlop={8} accessibilityLabel={t('forge.regex.deleteA11y')}>
                      <Text style={styles.removeText}>{t('forge.delete')}</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label={t('forge.regex.groupLabel')}
                          onPress={() => openAssist({ kind: 'entry', listKey: 'regexScripts', index, label: t('forge.regex.groupLabel') })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(script.name || '')}
                        onChangeText={name => updateEntry('regexScripts', index, { name })}
                        placeholder={t('forge.regex.namePlaceholder')}
                      />
                      <TextField
                        style={styles.entryInput}
                        value={String(script.findRegex || '')}
                        onChangeText={findRegex => updateEntry('regexScripts', index, { findRegex })}
                        placeholder={t('forge.regex.findPlaceholder')}
                      />
                      <TextField
                        style={styles.entryInput}
                        value={String(script.replaceString || '')}
                        onChangeText={replaceString => updateEntry('regexScripts', index, { replaceString })}
                        placeholder={t('forge.regex.replacePlaceholder')}
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.regex.markdownOnly')}</Text>
                        <Switch
                          value={script.markdownOnly === true}
                          onValueChange={markdownOnly => updateEntry('regexScripts', index, { markdownOnly })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.regex.promptOnly')}</Text>
                        <Switch
                          value={script.promptOnly === true}
                          onValueChange={promptOnly => updateEntry('regexScripts', index, { promptOnly })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.enabledLabel')}</Text>
                        <Switch
                          value={script.enabled !== false}
                          onValueChange={enabled => updateEntry('regexScripts', index, { enabled })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.entrySummary} numberOfLines={2}>{summary}</Text>
                  )}
                </View>
              );
            })}
            <SecondaryButton title={t('forge.regex.add')} onPress={addRegexScript} small />
          </FieldGroup>

          <FieldGroup label={t('forge.preset.groupLabel')} hint={t('forge.preset.groupHint')}>
            {presets.length === 0 ? (
              <Text style={styles.emptyText}>{t('forge.preset.empty')}</Text>
            ) : presets.map((preset, index) => {
              const entryKey = entryKeyOf('presets', preset, index);
              const expanded = expandedEntries.has(entryKey);
              const summary = String(preset.prompt || '').replace(/\s+/g, ' ').trim();
              return (
                <View key={entryKey} style={styles.entryCard}>
                  <View style={styles.entryHeader}>
                    <TouchableOpacity
                      style={styles.entryToggle}
                      onPress={() => toggleEntry(entryKey)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t('forge.preset.expandA11y', { n: index + 1 })}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{preset.name || t('forge.preset.entryFallback', { n: index + 1 })}</Text>
                      {preset.enabled === false ? <Text style={styles.entryDisabled}>{t('forge.disabled')}</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('presets', index)} hitSlop={8} accessibilityLabel={t('forge.preset.deleteA11y')}>
                      <Text style={styles.removeText}>{t('forge.delete')}</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label={t('forge.preset.groupLabel')}
                          onPress={() => openAssist({ kind: 'entry', listKey: 'presets', index, label: t('forge.preset.groupLabel') })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(preset.name || '')}
                        onChangeText={name => updateEntry('presets', index, { name })}
                        placeholder={t('forge.preset.namePlaceholder')}
                      />
                      <TextField
                        style={styles.entryContent}
                        value={String(preset.prompt || '')}
                        onChangeText={prompt => updateEntry('presets', index, { prompt })}
                        placeholder={t('forge.preset.contentPlaceholder')}
                        multiline
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>{t('forge.enabledLabel')}</Text>
                        <Switch
                          value={preset.enabled !== false}
                          onValueChange={enabled => updateEntry('presets', index, { enabled })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.entrySummary} numberOfLines={2}>{summary || t('forge.emptyContent')}</Text>
                  )}
                </View>
              );
            })}
            <SecondaryButton title={t('forge.preset.add')} onPress={addPreset} small />
          </FieldGroup>

          <Text style={styles.preserved}>
            {t('forge.preserved', { count: Array.isArray(form.alternateGreetings) ? form.alternateGreetings.length : 0 })}
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <SecondaryButton title={t('forge.cancel')} onPress={onClose} style={styles.footerButton} />
          <PrimaryButton title={t('forge.save')} onPress={save} style={styles.footerButton} />
        </View>
      </View>

      <Modal
        visible={!!assistTarget}
        transparent
        animationType="fade"
        onRequestClose={closeAssist}
      >
        <KeyboardAvoidingView
          style={styles.assistOverlay}
          // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
          // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.assistCard}>
            <Text style={styles.assistTitle}>{t('forge.assist.title', { label: assistLabel })}</Text>
            {isRegexAssist ? (
              <Text style={styles.assistWarning}>
                {t('forge.assist.regexWarning')}
              </Text>
            ) : null}
            {assistTarget ? (
              <Text style={styles.assistCurrent} numberOfLines={3}>
                {t('forge.assist.current', { content: assistPreview.trim() || t('forge.assist.empty') })}
              </Text>
            ) : null}
            <ScrollView
              style={styles.assistScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <TextField
                style={styles.assistInput}
                value={assistText}
                onChangeText={setAssistText}
                placeholder={t('forge.assist.placeholder')}
                multiline
                autoFocus
                scrollEnabled={false}
              />
            </ScrollView>
            {assistBusy ? (
              <View style={styles.assistBusyRow}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.assistBusyText}>{t('forge.assist.busy')}</Text>
              </View>
            ) : null}
            <View style={styles.assistActions}>
              <SecondaryButton title={t('forge.cancel')} onPress={closeAssist} style={styles.footerButton} />
              <PrimaryButton title={t('forge.generate')} onPress={submitAssist} disabled={assistBusy} style={styles.footerButton} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={!!imageGenTarget}
        transparent
        animationType="fade"
        onRequestClose={closeImageGenerate}
      >
        <KeyboardAvoidingView
          style={styles.assistOverlay}
          // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
          // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.assistCard}>
            <Text style={styles.assistTitle}>
              {imageGenTarget === 'bg' ? t('forge.imageGen.titleBg') : t('forge.imageGen.titleAvatar')}
            </Text>
            <Text style={styles.assistCurrent}>
              {t('forge.imageGen.desc')}
            </Text>
            <ScrollView
              style={styles.assistScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <TextField
                style={styles.assistInput}
                value={imageGenHint}
                onChangeText={setImageGenHint}
                placeholder={t('forge.imageGen.placeholder')}
                multiline
                autoFocus
                scrollEnabled={false}
              />
            </ScrollView>
            {imageGenBusy ? (
              <View style={styles.assistBusyRow}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.assistBusyText}>{t('forge.imageGen.busy')}</Text>
              </View>
            ) : null}
            <View style={styles.assistActions}>
              <SecondaryButton title={t('forge.cancel')} onPress={closeImageGenerate} style={styles.footerButton} />
              <PrimaryButton title={t('forge.generate')} onPress={submitImageGenerate} disabled={imageGenBusy} style={styles.footerButton} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <CardPreviewModal
        visible={previewOpen}
        draft={previewDraft}
        onClose={() => setPreviewOpen(false)}
        onSendTurn={handlePreviewTurn}
      />
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  previewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 12,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  previewActionText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 24 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  preserved: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  aigcNotice: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.xs,
  },
  aigcBadge: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginBottom: tokens.spacing.md,
  },
  assistButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.spacing.xs + 2,
    backgroundColor: theme.colors.surface,
  },
  assistButtonText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 3,
  },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginBottom: tokens.spacing.sm,
  },
  entryCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  entryToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: tokens.spacing.sm,
  },
  entryDisabled: {
    marginLeft: 6,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
  },
  entryBody: {
    marginTop: 2,
  },
  entryActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: tokens.spacing.sm,
  },
  entrySummary: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
  },
  entryTitle: {
    flex: 1,
    marginRight: tokens.spacing.sm,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
  },
  removeText: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  entryInput: {
    marginBottom: tokens.spacing.sm,
  },
  entryContent: {
    marginBottom: tokens.spacing.sm,
    minHeight: tokens.metrics.fieldHeight * 2,
  },
  imageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatarPreview: {
    width: 56,
    height: 56,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceBorder,
  },
  bgPreview: {
    width: 96,
    height: 56,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceBorder,
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  imageButtons: {
    flex: 1,
    marginLeft: tokens.spacing.md,
  },
  smallButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    marginBottom: tokens.spacing.xs,
  },
  smallButtonText: {
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  imageGenButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: tokens.spacing.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  imageGenText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 3,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
  },
  assistOverlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  assistCard: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '80%',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  assistTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '800',
    marginBottom: tokens.spacing.sm,
  },
  assistCurrent: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginBottom: tokens.spacing.sm,
  },
  assistWarning: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginTop: tokens.spacing.xs,
    marginBottom: tokens.spacing.sm,
  },
  assistScroll: {
    flexGrow: 0,
  },
  assistInput: {
    minHeight: tokens.metrics.fieldHeight * 2,
    marginBottom: tokens.spacing.md,
  },
  assistBusyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  assistBusyText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginLeft: tokens.spacing.sm,
  },
  assistActions: {
    flexDirection: 'row',
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  footerButton: { flex: 1, marginHorizontal: 4 },
});
