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

const MULTILINE_FIELDS = new Set([
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'creatorNotes',
  'postHistoryInstructions',
]);

const PLACEHOLDERS = {
  name: '例如：晚星',
  description: '外貌、身份、背景…',
  personality: '性格与说话方式…',
  scenario: '故事背景与你们的关系…',
  firstMes: '角色主动说的第一句话…',
  mesExample: '{{user}}：在吗\n晚星：在的',
  creatorNotes: '给用户的使用建议…',
  postHistoryInstructions: '给模型的持续要求…',
};

function splitKeywords(text) {
  return String(text || '')
    .split(/[、,，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function AssistButton({ onPress, label }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={styles.assistButton}
      onPress={onPress}
      activeOpacity={0.8}
      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={`辅助生成${label}`}
    >
      <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
      <Text style={styles.assistButtonText}>辅助生成</Text>
    </TouchableOpacity>
  );
}

export default function CardForgeEditor({ visible, draft, onClose, onSave, onAssistPrompt, onSimulateChat, onImageGenerate, visionAvailable = false }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
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
      if (isCurrent()) Alert.alert('图片读取失败', '请重试，或换一张图片。');
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
      Alert.alert('先选一张图片', target === 'bg' ? '请先选择背景图。' : '请先选择头像。');
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
      Alert.alert('功能不可用', '当前没有可用的模型配置。');
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
        Alert.alert('生成失败', 'AI 没有返回有效的卡片内容，请重试。');
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
      Alert.alert('生成失败', maskSecrets((error && error.message) || '请稍后重试。'));
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
      return Promise.reject(new Error('当前没有可用的模型配置。'));
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
      comment: `世界书条目 ${list.length + 1}`,
    })]);
    expandEntry(`worldInfo:${id}`);
  };

  const addRegexScript = () => {
    const id = `regex-${Date.now().toString(36)}`;
    patchList('regexScripts', list => [...list, createRegexScript({
      id,
      name: `正则脚本 ${list.length + 1}`,
    })]);
    expandEntry(`regexScripts:${id}`);
  };

  const addPreset = () => {
    const id = makeCharacterPresetId(presets);
    patchList('presets', list => [...list, {
      id,
      name: `预设 ${list.length + 1}`,
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
      Alert.alert('请先描述想修改的地方', '例如：把性格改得更傲娇一些。');
      return;
    }
    if (typeof onAssistPrompt !== 'function') {
      Alert.alert('功能不可用', '当前没有可用的模型配置。');
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
          Alert.alert('生成失败', 'AI 没有返回有效的 JSON，请重试。');
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
        Alert.alert('生成失败', 'AI 没有返回有效内容，请重试。');
        return;
      }
      if (target.kind === 'tags') {
        const list = text
          .split(/[、,，]+/)
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, MAX_FORGE_TAG_COUNT);
        if (list.length === 0) {
          Alert.alert('生成失败', 'AI 没有返回有效标签，请重试。');
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
      Alert.alert('生成失败', maskSecrets((error && error.message) || '请稍后重试。'));
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
    if (target.kind === 'tags') return '标签';
    return target.label || '条目';
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
          <Text style={styles.title}>当前角色卡</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.previewAction}
              onPress={() => setPreviewOpen(true)}
              hitSlop={8}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="预览角色卡并模拟对话"
            >
              <Ionicons name="eye-outline" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.previewActionText}>预览</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>直接在这里改也可以，保存后会写回制卡草稿。字段旁的「辅助生成」可以按你的描述让 AI 改写。</Text>
          <Text style={styles.aigcNotice}>{`· ${AIGC_NOTICE_TEXT}：AI 生成/改写的卡片内容会随导出文件携带生成标识。`}</Text>
          {isValidAigcMeta(form[AIGC_META_FIELD]) ? (
            <Text style={styles.aigcBadge}>{`本卡由 AI 生成 · 内容编号 ${form[AIGC_META_FIELD].contentCode || ''}`}</Text>
          ) : null}
          <FieldGroup
            label="头像"
            hint="角色列表与聊天气泡里显示的头像；支持 PNG / JPEG"
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
                  <Text style={styles.smallButtonText}>{form.avatarUri ? '更换' : '选择头像'}</Text>
                </TouchableOpacity>
                {form.avatarUri ? (
                  <TouchableOpacity style={styles.smallButton} onPress={() => clearImage('avatarUri')} hitSlop={6} activeOpacity={0.8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
                {visionAvailable ? (
                  <TouchableOpacity
                    style={styles.imageGenButton}
                    onPress={() => openImageGenerate('avatar')}
                    disabled={!form.avatarUri || imageGenBusy}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="根据头像图片生成角色卡"
                  >
                    <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
                    <Text style={styles.imageGenText}>按头像生成角色</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </FieldGroup>
          <FieldGroup
            label="背景图"
            hint="聊天页的背景图；支持 PNG / JPEG"
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
                  <Text style={styles.smallButtonText}>{form.bgUri ? '更换' : '选择背景'}</Text>
                </TouchableOpacity>
                {form.bgUri ? (
                  <TouchableOpacity style={styles.smallButton} onPress={() => clearImage('bgUri')} hitSlop={6} activeOpacity={0.8}>
                    <Text style={styles.removeText}>清除</Text>
                  </TouchableOpacity>
                ) : null}
                {visionAvailable ? (
                  <TouchableOpacity
                    style={styles.imageGenButton}
                    onPress={() => openImageGenerate('bg')}
                    disabled={!form.bgUri || imageGenBusy}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="根据背景图生成角色卡"
                  >
                    <Ionicons name="sparkles-outline" size={12} color={theme.colors.primarySoft} />
                    <Text style={styles.imageGenText}>按背景生成角色</Text>
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
                placeholder={PLACEHOLDERS[key] || ''}
                multiline={MULTILINE_FIELDS.has(key)}
              />
            </FieldGroup>
          ))}
          <FieldGroup
            label="系统提示"
            hint="原样保留，AI 不会改写它；需要时可以在这里手动调整"
            action={<AssistButton label="系统提示" onPress={() => openAssist({ kind: 'field', key: 'systemPrompt', label: '系统提示' })} />}
          >
            <TextField
              value={String(form.systemPrompt || '')}
              onChangeText={value => setForm(current => ({ ...current, systemPrompt: value }))}
              placeholder="例如：始终保持这个角色的说话方式，不要替用户行动"
              multiline
            />
          </FieldGroup>
          <FieldGroup
            label="标签"
            hint={`用顿号或逗号分隔，最多 ${MAX_FORGE_TAG_COUNT} 个`}
            action={<AssistButton label="标签" onPress={() => openAssist({ kind: 'tags', label: '标签' })} />}
          >
            <TextField value={tagText} onChangeText={setTagText} placeholder="例如：治愈、日常" />
          </FieldGroup>

          <FieldGroup label="世界书条目" hint="命中关键词后注入提示词，点条目标题展开编辑">
            {worldInfo.length === 0 ? (
              <Text style={styles.emptyText}>还没有世界书条目。</Text>
            ) : worldInfo.map((entry, index) => {
              const entryKey = entryKeyOf('worldInfo', entry, index);
              const expanded = expandedEntries.has(entryKey);
              const summary = [
                Array.isArray(entry.keys) && entry.keys.length ? `关键词：${entry.keys.join('、')}` : '',
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
                      accessibilityLabel={`展开世界书条目 ${index + 1}`}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{entry.comment || `条目 ${index + 1}`}</Text>
                      {entry.enabled === false ? <Text style={styles.entryDisabled}>已停用</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('worldInfo', index)} hitSlop={8} accessibilityLabel="删除世界书条目">
                      <Text style={styles.removeText}>删除</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label="世界书条目"
                          onPress={() => openAssist({ kind: 'entry', listKey: 'worldInfo', index, label: '世界书条目' })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(entry.comment || '')}
                        onChangeText={comment => updateEntry('worldInfo', index, { comment })}
                        placeholder="条目名称"
                      />
                      <TextField
                        style={styles.entryInput}
                        value={(Array.isArray(entry.keys) ? entry.keys : []).join(', ')}
                        onChangeText={text => updateEntry('worldInfo', index, { keys: splitKeywords(text) })}
                        placeholder="触发关键词（逗号分隔）"
                      />
                      <TextField
                        style={styles.entryContent}
                        value={String(entry.content || '')}
                        onChangeText={content => updateEntry('worldInfo', index, { content })}
                        placeholder="命中后注入的内容"
                        multiline
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>常驻（无需关键词）</Text>
                        <Switch
                          value={entry.constant === true}
                          onValueChange={constant => updateEntry('worldInfo', index, { constant })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>启用</Text>
                        <Switch
                          value={entry.enabled !== false}
                          onValueChange={enabled => updateEntry('worldInfo', index, { enabled })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.entrySummary} numberOfLines={2}>{summary || '未设置内容'}</Text>
                  )}
                </View>
              );
            })}
            <SecondaryButton title="添加世界书条目" onPress={addWorldEntry} small />
          </FieldGroup>

          <FieldGroup label="正则脚本" hint="对展示文本或发送提示词做替换，点条目标题展开编辑">
            {regexScripts.length === 0 ? (
              <Text style={styles.emptyText}>还没有正则脚本。</Text>
            ) : regexScripts.map((script, index) => {
              const entryKey = entryKeyOf('regexScripts', script, index);
              const expanded = expandedEntries.has(entryKey);
              const summary = String(script.findRegex || '').trim()
                ? `查找：${script.findRegex} → 替换：${script.replaceString || '（空）'}`
                : '未设置查找内容';
              return (
                <View key={entryKey} style={styles.entryCard}>
                  <View style={styles.entryHeader}>
                    <TouchableOpacity
                      style={styles.entryToggle}
                      onPress={() => toggleEntry(entryKey)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`展开正则脚本 ${index + 1}`}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{script.name || `脚本 ${index + 1}`}</Text>
                      {script.enabled === false ? <Text style={styles.entryDisabled}>已停用</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('regexScripts', index)} hitSlop={8} accessibilityLabel="删除正则脚本">
                      <Text style={styles.removeText}>删除</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label="正则脚本"
                          onPress={() => openAssist({ kind: 'entry', listKey: 'regexScripts', index, label: '正则脚本' })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(script.name || '')}
                        onChangeText={name => updateEntry('regexScripts', index, { name })}
                        placeholder="脚本名称"
                      />
                      <TextField
                        style={styles.entryInput}
                        value={String(script.findRegex || '')}
                        onChangeText={findRegex => updateEntry('regexScripts', index, { findRegex })}
                        placeholder="查找内容（或 /正则/ 标记）"
                      />
                      <TextField
                        style={styles.entryInput}
                        value={String(script.replaceString || '')}
                        onChangeText={replaceString => updateEntry('regexScripts', index, { replaceString })}
                        placeholder="替换为"
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>仅替换展示</Text>
                        <Switch
                          value={script.markdownOnly === true}
                          onValueChange={markdownOnly => updateEntry('regexScripts', index, { markdownOnly })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>仅用于发送提示词</Text>
                        <Switch
                          value={script.promptOnly === true}
                          onValueChange={promptOnly => updateEntry('regexScripts', index, { promptOnly })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>启用</Text>
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
            <SecondaryButton title="添加正则脚本" onPress={addRegexScript} small />
          </FieldGroup>

          <FieldGroup label="角色预设" hint="随提示词注入的文本预设，点条目标题展开编辑">
            {presets.length === 0 ? (
              <Text style={styles.emptyText}>还没有预设。</Text>
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
                      accessibilityLabel={`展开预设 ${index + 1}`}
                    >
                      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textFaint} />
                      <Text style={styles.entryTitle} numberOfLines={1}>{preset.name || `预设 ${index + 1}`}</Text>
                      {preset.enabled === false ? <Text style={styles.entryDisabled}>已停用</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeEntry('presets', index)} hitSlop={8} accessibilityLabel="删除预设">
                      <Text style={styles.removeText}>删除</Text>
                    </TouchableOpacity>
                  </View>
                  {expanded ? (
                    <View style={styles.entryBody}>
                      <View style={styles.entryActions}>
                        <AssistButton
                          label="角色预设"
                          onPress={() => openAssist({ kind: 'entry', listKey: 'presets', index, label: '角色预设' })}
                        />
                      </View>
                      <TextField
                        style={styles.entryInput}
                        value={String(preset.name || '')}
                        onChangeText={name => updateEntry('presets', index, { name })}
                        placeholder="预设名称"
                      />
                      <TextField
                        style={styles.entryContent}
                        value={String(preset.prompt || '')}
                        onChangeText={prompt => updateEntry('presets', index, { prompt })}
                        placeholder="预设内容（注入提示词）"
                        multiline
                      />
                      <View style={styles.switchRow}>
                        <Text style={styles.switchLabel}>启用</Text>
                        <Switch
                          value={preset.enabled !== false}
                          onValueChange={enabled => updateEntry('presets', index, { enabled })}
                          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                          thumbColor={theme.colors.primaryContrast}
                        />
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.entrySummary} numberOfLines={2}>{summary || '未设置内容'}</Text>
                  )}
                </View>
              );
            })}
            <SecondaryButton title="添加预设" onPress={addPreset} small />
          </FieldGroup>

          <Text style={styles.preserved}>
            {`备用开场白 ${Array.isArray(form.alternateGreetings) ? form.alternateGreetings.length : 0} 条随草稿原样保留`}
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <SecondaryButton title="取消" onPress={onClose} style={styles.footerButton} />
          <PrimaryButton title="保存" onPress={save} style={styles.footerButton} />
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
            <Text style={styles.assistTitle}>{`辅助生成「${assistLabel}」`}</Text>
            {isRegexAssist ? (
              <Text style={styles.assistWarning}>
                正则表达式对 AI 来说较难正确生成，生成结果常不可用或存在隐患，不建议依赖 AI 编写正则；建议手动核对与测试后再启用。
              </Text>
            ) : null}
            {assistTarget ? (
              <Text style={styles.assistCurrent} numberOfLines={3}>
                {`当前内容：${assistPreview.trim() || '（空）'}`}
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
                placeholder="描述想修改的地方，例如：把性格改得更傲娇一些"
                multiline
                autoFocus
                scrollEnabled={false}
              />
            </ScrollView>
            {assistBusy ? (
              <View style={styles.assistBusyRow}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.assistBusyText}>AI 正在改写…</Text>
              </View>
            ) : null}
            <View style={styles.assistActions}>
              <SecondaryButton title="取消" onPress={closeAssist} style={styles.footerButton} />
              <PrimaryButton title="生成" onPress={submitAssist} disabled={assistBusy} style={styles.footerButton} />
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
              {imageGenTarget === 'bg' ? '按背景图生成角色卡' : '按头像生成角色卡'}
            </Text>
            <Text style={styles.assistCurrent}>
              会把这张图片作为识图输入交给当前模型，读图后写出一整张角色卡覆盖当前草稿的文本字段（图片保持不变）。
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
                placeholder="可选的补充要求，例如：这是个清冷剑客，背景放在雪山"
                multiline
                autoFocus
                scrollEnabled={false}
              />
            </ScrollView>
            {imageGenBusy ? (
              <View style={styles.assistBusyRow}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.assistBusyText}>AI 正在读图写卡…</Text>
              </View>
            ) : null}
            <View style={styles.assistActions}>
              <SecondaryButton title="取消" onPress={closeImageGenerate} style={styles.footerButton} />
              <PrimaryButton title="生成" onPress={submitImageGenerate} disabled={imageGenBusy} style={styles.footerButton} />
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
