import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Buffer } from 'buffer';

import {
  buildSystemPrompt,
  createRegexScript,
  createWorldEntry,
  ensureUniqueIds,
  parseCardFromJson,
  parseCardFromPng,
  REGEX_PLACEMENT_LABELS,
  WORLD_POSITION_LABELS,
} from './cardParser';
import { exportCardFile } from './cardExporter';
import ChapterModal from './ChapterModal';
import { Card, FieldHint, FieldLabel, TextField, TopicButton } from './ui';
import { useApp } from './context/AppContext';
import { useNavigation } from '@react-navigation/native';
import PresetPanel from './PresetPanel';
import { compileRegex } from './regexEngine';
import { maskSecrets } from './secrets';
import { createGroupSession } from './storage';
import { useTheme } from './theme/ThemeContext';

const NO_CARD_DATA_MESSAGE =
  '该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。';

const WORLD_POSITION_KEYS = Object.keys(WORLD_POSITION_LABELS)
  .map(Number)
  .sort((a, b) => a - b);
const REGEX_PLACEMENT_KEYS = [1, 2, 3, 5, 6];
const WORLD_ROLES = ['system', 'user', 'assistant'];

function getPickedAsset(result) {
  if (!result || result.canceled || result.type === 'cancel') return null;
  if (Array.isArray(result.assets) && result.assets[0]) return result.assets[0];
  if (result.uri) return result;
  return null;
}

function assetLooksLike(asset, ext, mimes) {
  const mime = String(asset?.mimeType || '').toLowerCase();
  const name = String(asset?.name || asset?.uri || '').toLowerCase();
  return mimes.includes(mime) || name.endsWith(ext);
}

function isPngBuffer(buffer) {
  return (
    buffer
    && buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  );
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function placementText(placement) {
  return placement
    .map(item => REGEX_PLACEMENT_LABELS[item] || `范围 ${item}`)
    .join('、');
}

function hasCardContent(card) {
  if (!card) return false;
  if (card.name) return true;
  if (card.systemPrompt) return true;
  if (card.worldInfo?.length) return true;
  if (card.regexScripts?.length) return true;
  const fields = card.fields || {};
  return Boolean(
    fields.description
    || fields.personality
    || fields.scenario
    || fields.firstMes
    || (fields.alternateGreetings && fields.alternateGreetings.length)
    || fields.mesExample
    || fields.creatorNotes
    || fields.postHistoryInstructions
  );
}

function buildCharacterPatch(card) {
  const fields = card.fields || {};
  return {
    id: `card-${Date.now().toString(36)}`,
    name: card.name || '导入角色',
    systemPrompt: fields.systemPrompt || '',
    systemPromptComposed: card.systemPrompt || '',
    description: fields.description || '',
    personality: fields.personality || '',
    scenario: fields.scenario || '',
    firstMes: fields.firstMes || '',
    alternateGreetings: Array.isArray(fields.alternateGreetings) ? fields.alternateGreetings : [],
    mesExample: fields.mesExample || '',
    creatorNotes: fields.creatorNotes || '',
    postHistoryInstructions: fields.postHistoryInstructions || '',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    worldInfo: Array.isArray(card.worldInfo) ? card.worldInfo : [],
    regexScripts: Array.isArray(card.regexScripts) ? card.regexScripts : [],
  };
}

function DataField({ label, value }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  if (!value) return null;
  return (
    <View style={styles.dataField}>
      <Text style={styles.dataFieldLabel}>{label}</Text>
      <Text style={styles.dataFieldValue} numberOfLines={6}>{value}</Text>
    </View>
  );
}

function ToggleRow({ label, value, onValueChange }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.surfaceBorder, true: theme.colors.primary }}
        thumbColor={theme.colors.primaryContrast}
      />
    </View>
  );
}

function Chip({ label, active, onPress }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function NumberField({ label, value, onCommit }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => {
    setText(String(value ?? ''));
  }, [value]);
  const commit = () => {
    const parsed = parseInt(String(text).replace(/[^0-9-]/g, ''), 10);
    if (Number.isFinite(parsed)) {
      setText(String(parsed));
      onCommit(parsed);
    } else {
      setText(String(value ?? ''));
    }
  };
  return (
    <View style={styles.numberField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextField
        style={styles.inputSmall}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onEndEditing={commit}
        keyboardType="number-pad"
        placeholder={label}
      />
    </View>
  );
}

function CollapsibleSection({ title, count, expanded, onToggle, onAdd, addLabel, icon, children }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={styles.sectionCard}>
      <TouchableOpacity style={styles.sectionHeader} onPress={onToggle} activeOpacity={0.8}>
        <View style={styles.sectionTitleRow}>
          {icon ? <Ionicons name={icon} size={15} color={theme.colors.primaryMuted} /> : null}
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.primaryMuted} />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.sectionBody}>
          {children}
          {onAdd ? (
            <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.addButtonText}>{addLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function WorldEntryEditor({ entry, index, onChange, onRemove }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  const position = WORLD_POSITION_LABELS[entry.position] ? entry.position : 0;
  const cyclePosition = () => {
    const current = WORLD_POSITION_KEYS.indexOf(position);
    const next = WORLD_POSITION_KEYS[(current + 1) % WORLD_POSITION_KEYS.length];
    onChange({ position: next, positionLabel: WORLD_POSITION_LABELS[next] });
  };
  const cycleRole = () => {
    const current = WORLD_ROLES.indexOf(entry.role);
    const next = WORLD_ROLES[(current + 1) % WORLD_ROLES.length];
    onChange({ role: next });
  };
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {entry.comment || `条目 ${index + 1}`}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>删除</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>名称</Text>
      <TextField
        style={styles.inputSmall}
        value={entry.comment}
        onChangeText={comment => onChange({ comment })}
        placeholder="世界书条目名称"
      />
      <Text style={styles.fieldLabel}>触发关键词（逗号分隔）</Text>
      <TextField
        style={styles.inputSmall}
        value={keys.join(', ')}
        onChangeText={text => onChange({ keys: splitKeywords(text) })}
        placeholder="关键词一, 关键词二"
      />
      <Text style={styles.fieldLabel}>内容</Text>
      <TextField
        style={styles.contentInput}
        value={entry.content}
        onChangeText={content => onChange({ content })}
        placeholder="命中后注入提示词的内容"
        multiline
        textAlignVertical="top"
      />
      <ToggleRow
        label="常驻（无需关键词）"
        value={entry.constant}
        onValueChange={constant => onChange({ constant })}
      />
      <ToggleRow
        label="启用"
        value={entry.enabled}
        onValueChange={enabled => onChange({ enabled })}
      />
      <View style={styles.cycleRow}>
        <TouchableOpacity style={styles.cycleButton} onPress={cyclePosition} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>位置：{WORLD_POSITION_LABELS[position]}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cycleButton} onPress={cycleRole} activeOpacity={0.8}>
          <Text style={styles.cycleButtonText}>角色：{entry.role}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.numberRow}>
        <NumberField
          label="顺序"
          value={entry.order ?? 100}
          onCommit={order => onChange({ order })}
        />
        {position === 4 ? (
          <NumberField
            label="深度"
            value={entry.depth ?? 4}
            onCommit={depth => onChange({ depth })}
          />
        ) : null}
      </View>
    </View>
  );
}

function RegexEntryEditor({ script, index, onChange, onRemove }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const placement = Array.isArray(script.placement) ? script.placement : [1, 2];
  const togglePlacement = value => {
    const has = placement.includes(value);
    const next = has
      ? placement.filter(item => item !== value)
      : [...placement, value].sort((a, b) => a - b);
    onChange({ placement: next, placementLabel: placementText(next) });
  };
  return (
    <View style={styles.entryCard}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {script.name || `正则 ${index + 1}`}
        </Text>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>删除</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>名称</Text>
      <TextField
        style={styles.inputSmall}
        value={script.name}
        onChangeText={name => onChange({ name })}
        placeholder="正则脚本名称"
      />
      <Text style={styles.fieldLabel}>匹配表达式</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.findRegex}
        onChangeText={findRegex => onChange({ findRegex })}
        placeholder="例如：\\bfoo\\b"
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.fieldLabel}>替换为</Text>
      <TextField
        style={[styles.contentInput, styles.codeInput]}
        value={script.replaceString}
        onChangeText={replaceString => onChange({ replaceString })}
        placeholder="替换后的文本，可留空表示删除"
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.fieldLabel}>flags</Text>
      <TextField
        style={[styles.inputSmall, styles.codeInput]}
        value={script.flags}
        onChangeText={flags => onChange({ flags })}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="g"
      />
      <Text style={styles.dataMeta}>/表达式/flags 使用内嵌 flags；裸表达式的 flags 留空时仅替换首个匹配。</Text>
      <Text style={styles.fieldLabel}>作用范围</Text>
      <View style={styles.chipRow}>
        {REGEX_PLACEMENT_KEYS.map(key => (
          <Chip
            key={key}
            label={REGEX_PLACEMENT_LABELS[key] || `范围 ${key}`}
            active={placement.includes(key)}
            onPress={() => togglePlacement(key)}
          />
        ))}
      </View>
      <Text style={styles.dataMeta}>AI 输出包含开场白与助手历史消息。</Text>
      <ToggleRow label="启用" value={script.enabled} onValueChange={enabled => onChange({ enabled })} />
      <ToggleRow
        label="仅用于界面显示"
        value={script.markdownOnly}
        onValueChange={markdownOnly => onChange({ markdownOnly })}
      />
      <ToggleRow
        label="仅用于发送提示词"
        value={script.promptOnly}
        onValueChange={promptOnly => onChange({ promptOnly })}
      />
    </View>
  );
}

function worldEntryMeta(entry) {
  if (entry.constant) return '常驻';
  const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
  if (keys.length) return `关键词：${keys.join('、')}`;
  const content = String(entry.content || '').replace(/\s+/g, ' ').trim();
  return content ? content.slice(0, 40) : '未设置关键词';
}

function SummaryRow({ title, meta, enabled, onPress }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity style={styles.summaryRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.summaryInfo}>
        <Text style={styles.summaryTitle} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={styles.summaryMeta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {enabled === false ? (
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>已停用</Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
    </TouchableOpacity>
  );
}

export default function CharacterScreen() {
  const {
    character,
    characters,
    activeId,
    loaded,
    updateCharacter,
    switchCharacter,
    ensureCharacterSession,
    addCharacter,
    deleteCharacter,
    pinCharacter,
    deleteCharacters,
    refreshSessions,
    sessions,
    activeSessionId,
    switchSession,
    deleteSessions,
  } = useApp();
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [name, setName] = useState('');
  const [tags, setTags] = useState([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMes, setFirstMes] = useState('');
  const [alternateGreetings, setAlternateGreetings] = useState([]);
  const [mesExample, setMesExample] = useState('');
  const [worldInfo, setWorldInfo] = useState([]);
  const [regexScripts, setRegexScripts] = useState([]);
  const [expandedWorld, setExpandedWorld] = useState(false);
  const [expandedRegex, setExpandedRegex] = useState(false);
  const [editingWorldId, setEditingWorldId] = useState(null);
  const [editingRegexId, setEditingRegexId] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [bgPreview, setBgPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [presetPanelOpen, setPresetPanelOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef(false);
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupSelected, setGroupSelected] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [groupAvatarUri, setGroupAvatarUri] = useState('');
  const [groupBgUri, setGroupBgUri] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [query, setQuery] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const [topic, setTopic] = useState(null);
  const seededIdRef = useRef(null);
  const screenSessionRef = useRef({ activeId });
  if (screenSessionRef.current.activeId !== activeId) {
    screenSessionRef.current = { activeId };
  }

  useEffect(() => () => {
    screenSessionRef.current = {};
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (seededIdRef.current === activeId) return;
    seededIdRef.current = activeId;
    setName(character.name || '');
    setSystemPrompt(character.systemPrompt || '');
    setDescription(character.description || '');
    setPersonality(character.personality || '');
    setTags(Array.isArray(character.tags) ? character.tags : []);
    setScenario(character.scenario || '');
    setFirstMes(character.firstMes || '');
    setAlternateGreetings(Array.isArray(character.alternateGreetings) ? character.alternateGreetings : []);
    setMesExample(String(character.mesExample || ''));
    setWorldInfo(
      ensureUniqueIds(Array.isArray(character.worldInfo) ? character.worldInfo : [], 'entry')
    );
    setRegexScripts(
      ensureUniqueIds(
        Array.isArray(character.regexScripts) ? character.regexScripts : [],
        'regex'
      )
    );
    setEditingWorldId(null);
    setEditingRegexId(null);
    setAvatarPreview(character.avatarUri || null);
    setBgPreview(character.bgUri || null);
  }, [loaded, activeId, character]);

  const updateWorldEntry = (id, patch) => {
    setWorldInfo(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeWorldEntry = id => {
    setWorldInfo(list => list.filter(item => item.id !== id));
  };

  const addWorldEntry = () => {
    setExpandedWorld(true);
    const id = `entry-${Date.now().toString(36)}`;
    setWorldInfo(list => [
      ...list,
      createWorldEntry({
        id,
        comment: `世界书条目 ${list.length + 1}`,
      }),
    ]);
    setEditingWorldId(id);
  };

  const updateRegexScript = (id, patch) => {
    setRegexScripts(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeRegexScript = id => {
    setRegexScripts(list => list.filter(item => item.id !== id));
  };

  const addRegexScript = () => {
    setExpandedRegex(true);
    const id = `regex-${Date.now().toString(36)}`;
    setRegexScripts(list => [
      ...list,
      createRegexScript({
        id,
        name: `正则脚本 ${list.length + 1}`,
      }),
    ]);
    setEditingRegexId(id);
  };

  const save = async () => {
    if (!loaded) {
      Alert.alert('角色加载中', '请稍候再保存。');
      return;
    }
    for (const [index, script] of regexScripts.entries()) {
      if (script.enabled === false) continue;
      try {
        compileRegex(script.findRegex, script.flags);
      } catch (error) {
        setExpandedRegex(true);
        setEditingRegexId(script.id);
        Alert.alert(
          '正则脚本无效',
          maskSecrets(`第 ${index + 1} 条「${script.name || '未命名'}」：${error.message}`)
        );
        return;
      }
    }
    const session = screenSessionRef.current;
    const trimmedPrompt = systemPrompt.trim();
    const next = {
      id: character.id || 'default',
      name: name.trim() || 'EasyChat2 助手',
      systemPrompt: trimmedPrompt || '你是 EasyChat2 的智能助手，回答简洁清晰。',
      systemPromptComposed: buildSystemPrompt({
        description: description.trim(),
        personality: personality.trim(),
        scenario: scenario.trim(),
        systemPrompt: trimmedPrompt,
        postHistoryInstructions: character.postHistoryInstructions,
      }),
      description: description.trim(),
      personality: personality.trim(),
      tags,
      scenario: scenario.trim(),
      firstMes: firstMes.trim(),
      alternateGreetings: alternateGreetings.map(item => String(item || '').trim()).filter(Boolean),
      mesExample: mesExample.trim(),
      worldInfo,
      regexScripts,
      avatarUri: avatarPreview || '',
      bgUri: bgPreview || '',
    };
    try {
      await updateCharacter(next);
      if (screenSessionRef.current !== session) return;
      setName(next.name);
      setSystemPrompt(next.systemPrompt);
      setDescription(next.description);
      setPersonality(next.personality);
      setScenario(next.scenario);
      setFirstMes(next.firstMes);
      setAlternateGreetings(Array.isArray(next.alternateGreetings) ? next.alternateGreetings : []);
      setMesExample(String(next.mesExample || ''));
      setWorldInfo(next.worldInfo);
      setRegexScripts(next.regexScripts);
      Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  };

  const importCard = async () => {
    if (importing || !loaded) return;
    setImporting(true);

    try {
      let result;
      try {
        result = await DocumentPicker.getDocumentAsync({
          type: ['image/png', 'application/json'],
          copyToCacheDirectory: true,
          multiple: false,
        });
      } catch (error) {
        Alert.alert('文件读取错误，请重试');
        return;
      }

      const asset = getPickedAsset(result);
      if (!asset?.uri) return;

      let buffer;
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        buffer = Buffer.from(base64, 'base64');
      } catch (error) {
        Alert.alert('文件读取错误，请重试');
        return;
      }

      const isPng = assetLooksLike(asset, '.png', ['image/png', 'image/x-png']);
      const isJson = assetLooksLike(asset, '.json', ['application/json', 'text/json']);
      const treatAsPng = isPngBuffer(buffer) || (isPng && !isJson);

      let parsed;
      try {
        parsed = treatAsPng
          ? parseCardFromPng(buffer)
          : parseCardFromJson(buffer.toString('utf8'));
      } catch (error) {
        const detail = maskSecrets(error?.message || String(error));
        console.warn('[角色卡导入] 解析失败：', detail);
        Alert.alert('角色卡解析失败', detail || '请确认文件格式是否正确。');
        return;
      }

      if (treatAsPng && parsed === null) {
        Alert.alert('无法导入', NO_CARD_DATA_MESSAGE);
        return;
      }

      if (!hasCardContent(parsed)) {
        Alert.alert('无法导入', '未从文件中识别到角色内容，请确认卡片结构是否完整。');
        return;
      }

      const next = buildCharacterPatch(parsed);
      try {
        const created = await addCharacter(next);

        const session = screenSessionRef.current;
        let imageFailed = false;
        if (treatAsPng && asset?.uri) {
          try {
            const avatarDir = `${FileSystem.documentDirectory}avatars/`;
            await FileSystem.makeDirectoryAsync(avatarDir, { intermediates: true });
            const dest = `${avatarDir}${created.id}.png`;
            await FileSystem.copyAsync({ from: asset.uri, to: dest });
            await updateCharacter({ id: created.id, avatarUri: dest, bgUri: dest });
            if (screenSessionRef.current === session && session.activeId === created.id) {
              setAvatarPreview(dest);
              setBgPreview(dest);
            }
          } catch (error) {
            imageFailed = true;
          }
        }

        if (screenSessionRef.current === session && session.activeId === created.id) {
          setExpandedWorld(false);
          setExpandedRegex(false);
        }
        const summary = [
          `已加载角色：${next.name}`,
          `世界书 ${next.worldInfo.length} 条`,
          `正则 ${next.regexScripts.length} 条`,
        ].join('，');
        Alert.alert(
          imageFailed ? '角色已导入，图片保存失败' : '导入成功',
          imageFailed ? `${summary}。请在该角色页面重新选择头像和背景图。` : summary
        );
      } catch (error) {
        Alert.alert('导入失败', '请检查存储空间或权限。');
      }
    } finally {
      setImporting(false);
    }
  };

  const readAvatarBytes = async () => {
    const uri = character && character.avatarUri;
    if (!uri) return null;
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return Buffer.from(base64, 'base64');
    } catch (error) {
      return null;
    }
  };

  const runExport = async format => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExporting(true);
    try {
      const avatarBytes = format === 'png' ? await readAvatarBytes() : null;
      const uri = await exportCardFile(character, format, avatarBytes);
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available) {
        await Sharing.shareAsync(uri, {
          mimeType: format === 'png' ? 'image/png' : 'application/json',
          dialogTitle: '导出角色卡',
        });
      } else {
        Alert.alert('导出完成', `文件已生成：\n${uri}`);
      }
    } catch (error) {
      Alert.alert('导出失败', '请稍后重试。');
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  const onExport = () => {
    if (exportBusyRef.current || !loaded) return;
    const dirty = String(name || '').trim() !== String((character && character.name) || '').trim();
    Alert.alert(
      '导出角色卡',
      dirty ? '当前有未保存的编辑，将导出已保存的内容。请选择格式。' : '请选择导出格式。',
      [
        { text: '取消', style: 'cancel' },
        { text: 'PNG 图片', onPress: () => runExport('png') },
        { text: 'JSON 文件', onPress: () => runExport('json') },
      ]
    );
  };

  const toggleGroupMember = id => {
    setGroupSelected(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : (current.length >= 8 ? current : [...current, id])
    ));
  };

  const onCreateGroup = async () => {
    if (groupSelected.length < 2 || groupSelected.length > 8) {
      Alert.alert('成员数量不符', '群聊需要选择 2 到 8 个角色。');
      return;
    }
    if (creatingGroup) return;
    setCreatingGroup(true);
    try {
      const members = groupSelected.slice();
      const fallbackName = characters
        .filter(item => members.includes(item.id))
        .map(item => item.name || '未命名角色')
        .join('、');
      await createGroupSession(members, groupName.trim() || fallbackName, {
        avatarUri: groupAvatarUri,
        bgUri: groupBgUri,
      });
      await refreshSessions();
      setGroupPanelOpen(false);
      setGroupSelected([]);
      setGroupName('');
      setGroupAvatarUri('');
      setGroupBgUri('');
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('创建失败', '请检查存储空间或权限。');
    } finally {
      setCreatingGroup(false);
    }
  };

  const onSwitch = id => {
    switchCharacter(id)
      .then(() => ensureCharacterSession(id))
      .catch(() => {
        Alert.alert('切换失败', '请检查存储空间或权限。');
      });
  };

  const visibleCharacters = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return characters;
    return characters.filter(item => {
      const name = String(item.name || '').toLowerCase();
      if (name.includes(text)) return true;
      return (item.tags || []).some(tag => String(tag).toLowerCase().includes(text));
    });
  }, [characters, query]);

  const activeIsGroup = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).some(
      item => item && item.id === activeSessionId && item.type === 'group'
    ),
    [sessions, activeSessionId]
  );

  const characterMap = useMemo(() => {
    const map = new Map();
    characters.forEach(item => map.set(item.id, item));
    return map;
  }, [characters]);

  const groupNameOf = useCallback(session => {
    const names = (session.members || [])
      .map(id => (characterMap.get(id) || {}).name)
      .filter(Boolean);
    return String(session.name || '').trim() || names.join('、') || '群聊';
  }, [characterMap]);

  const visibleGroups = useMemo(() => {
    const list = (Array.isArray(sessions) ? sessions : []).filter(
      item => item && item.type === 'group'
    );
    const text = query.trim().toLowerCase();
    if (!text) return list;
    return list.filter(item => groupNameOf(item).toLowerCase().includes(text));
  }, [sessions, query, groupNameOf]);

  const onOpenGroup = useCallback(group => {
    switchSession(group.id)
      .then(() => navigation.navigate('聊天'))
      .catch(() => {
        Alert.alert('切换失败', '请检查存储空间或权限。');
      });
  }, [switchSession, navigation]);

  const toggleEditMode = () => {
    setEditMode(current => {
      if (current) setSelectedIds([]);
      return !current;
    });
  };

  const toggleSelect = id => {
    setSelectedIds(current => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  };

  const selectAll = () => {
    setSelectedIds(
      characters.filter(item => item.id !== 'default').map(item => item.id)
    );
  };

  const onTogglePin = item => {
    pinCharacter(item.id, !item.pinned).catch(() => {
      Alert.alert('置顶失败', '请检查存储空间或权限。');
    });
  };

  const runDeleteSelected = (ids, deleteMemories) => {
    const memoryIds = sessionsOfCharacters(ids);
    const afterCharacterDelete = () => (
      deleteMemories && memoryIds.length > 0 ? deleteSessions(memoryIds) : null
    );
    deleteCharacters(ids)
      .then(afterCharacterDelete)
      .then(() => {
        setSelectedIds([]);
        setEditMode(false);
      })
      .catch(error => {
        Alert.alert('删除失败', (error && error.message) || '请检查存储空间或权限。');
      });
  };

  const confirmSelectedDelete = ids => {
    const memoryCount = sessionsOfCharacters(ids).length;
    if (memoryCount === 0) {
      runDeleteSelected(ids, false);
      return;
    }
    Alert.alert(
      '删除角色',
      `选中的角色还有 ${memoryCount} 条记忆。是否连同这些记忆一起删除？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '仅删角色', onPress: () => runDeleteSelected(ids, false) },
        {
          text: '角色和记忆都删',
          style: 'destructive',
          onPress: () => runDeleteSelected(ids, true),
        },
      ]
    );
  };

  const onDeleteSelected = () => {
    if (selectedIds.length === 0) return;
    const allSelected = selectedIds.length >= characters.filter(item => item.id !== 'default').length;
    if (!allSelected) {
      Alert.alert('删除角色', `将删除选中的 ${selectedIds.length} 个角色。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '继续',
          style: 'destructive',
          onPress: () => confirmSelectedDelete(selectedIds),
        },
      ]);
      return;
    }
    Alert.alert(
      '删除全部角色',
      '这会删除除默认角色外的全部角色，且无法恢复。请输入「删除」以确认。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认删除',
          style: 'destructive',
          onPress: () => promptConfirmAllDelete(),
        },
      ]
    );
  };

  const promptConfirmAllDelete = () => {
    Alert.prompt
      ? Alert.prompt('输入确认', '请输入「删除」两个字以确认。', value => {
        if (String(value || '').trim() === '删除') {
          confirmSelectedDelete(selectedIds);
        } else {
          Alert.alert('已取消', '确认文字不匹配，未执行删除。');
        }
      })
      : Alert.alert('无法输入确认', '当前平台不支持输入确认，请逐个删除。');
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    if ((tags || []).includes(tag)) {
      setTagDraft('');
      return;
    }
    setTags(current => [...current, tag]);
    setTagDraft('');
  };

  const removeTag = tag => {
    setTags(current => current.filter(item => item !== tag));
  };

  const addGreeting = () => {
    setAlternateGreetings(current => [...current, '']);
  };

  const updateGreeting = (index, value) => {
    setAlternateGreetings(current => current.map((item, i) => (i === index ? value : item)));
  };

  const removeGreeting = index => {
    setAlternateGreetings(current => current.filter((_, i) => i !== index));
  };

  const onNewCharacter = async () => {
    if (!loaded) return;
    try {
      await addCharacter({ name: '新角色' });
    } catch (error) {
      Alert.alert('新建失败', '请检查存储空间或权限。');
    }
  };

  const sessionsOfCharacters = ids => {
    const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));
    return (Array.isArray(sessions) ? sessions : [])
      .filter(session => session && idSet.has(String(session.characterId || '')))
      .map(session => session.id);
  };

  const onDeleteCharacter = item => {
    const memoryIds = sessionsOfCharacters([item.id]);
    const runDelete = deleteMemories => {
      const doDelete = () => deleteCharacter(item.id);
      const chain = deleteMemories && memoryIds.length > 0
        ? doDelete().then(() => deleteSessions(memoryIds))
        : doDelete();
      chain.catch(error => {
        Alert.alert('删除失败', (error && error.message) || '请稍后重试。');
      });
    };
    if (memoryIds.length === 0) {
      Alert.alert('删除角色', `确定删除「${item.name || '未命名角色'}」吗？`, [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => runDelete(false) },
      ]);
      return;
    }
    Alert.alert(
      '删除角色',
      `「${item.name || '未命名角色'}」还有 ${memoryIds.length} 条记忆。是否连同这些记忆一起删除？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '仅删角色', onPress: () => runDelete(false) },
        {
          text: '角色和记忆都删',
          style: 'destructive',
          onPress: () => runDelete(true),
        },
      ]
    );
  };

  const pickImage = async (setter, fieldName) => {
    if (!loaded) return;
    const session = screenSessionRef.current;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const ext = asset.uri.endsWith('.png') ? '.png' : '.jpg';
      const dest = `${dir}${character.id}-${fieldName}-${Date.now()}${ext}`;
      await FileSystem.copyAsync({ from: asset.uri, to: dest });
      // 清理旧文件，避免头像/背景图无限堆积；但群聊的头像与背景是直接引用
      // 角色图片路径的，必须先确认没有会话还在引用，否则会出现“群聊头像变空白”。
      const draftValue = fieldName === 'avatar' ? avatarPreview : bgPreview;
      [character.avatarUri, draftValue].forEach(previous => {
        if (!previous || previous === dest || !previous.startsWith(dir)) return;
        const stillReferenced = (sessions || []).some(item => (
          item && (item.avatarUri === previous || item.bgUri === previous)
        ));
        if (!stillReferenced) {
          FileSystem.deleteAsync(previous, { idempotent: true }).catch(() => {});
        }
      });
      if (screenSessionRef.current === session) setter(dest);
    } catch (error) {
      Alert.alert('图片读取失败', '请重试。');
    }
  };

  const pickAvatar = () => pickImage(setAvatarPreview, 'avatar');
  const pickBg = () => pickImage(setBgPreview, 'bg');

  const clearBgImage = async () => {
    if (!loaded) {
      Alert.alert('角色加载中', '请稍候再操作。');
      return;
    }
    const session = screenSessionRef.current;
    const previous = bgPreview;
    setBgPreview(null);
    try {
      await updateCharacter({ id: character.id, bgUri: '' });
    } catch (error) {
      if (screenSessionRef.current === session) setBgPreview(previous);
      Alert.alert('清除失败', '请检查存储空间或权限。');
    }
  };

  const editingWorldIndex = worldInfo.findIndex(item => item.id === editingWorldId);
  const editingWorldEntry = editingWorldIndex >= 0 ? worldInfo[editingWorldIndex] : null;
  const editingRegexIndex = regexScripts.findIndex(item => item.id === editingRegexId);
  const editingRegexEntry = editingRegexIndex >= 0 ? regexScripts[editingRegexIndex] : null;

  const card = character || {};

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
      >
        <View style={styles.pageHeader}>
          <Text style={styles.title}>角色</Text>
          <FieldHint style={styles.hint}>聊天时会把这里的设定作为系统提示词发送给模型。</FieldHint>
        </View>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="people-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>角色库</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{characters.length}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.pillButton, !loaded && styles.buttonDisabled]}
              onPress={onNewCharacter}
              disabled={!loaded}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>新建</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pillButton, (!loaded || characters.length < 2) && styles.buttonDisabled]}
              onPress={() => setGroupPanelOpen(true)}
              disabled={!loaded || characters.length < 2}
              activeOpacity={0.8}
            >
              <Ionicons name="people" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>群聊</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pillButton, !loaded && styles.buttonDisabled]}
              onPress={toggleEditMode}
              disabled={!loaded}
              activeOpacity={0.8}
            >
              <Ionicons name={editMode ? 'close' : 'checkmark-circle-outline'} size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>{editMode ? '完成' : '多选'}</Text>
            </TouchableOpacity>
          </View>
          {editMode ? (
            <View style={styles.selectBar}>
              <TouchableOpacity onPress={selectAll} activeOpacity={0.8}>
                <Text style={styles.selectBarText}>全选</Text>
              </TouchableOpacity>
              <Text style={styles.selectBarCount}>{`已选 ${selectedIds.length}`}</Text>
              <TouchableOpacity
                style={[styles.selectBarDelete, selectedIds.length === 0 && styles.buttonDisabled]}
                onPress={onDeleteSelected}
                disabled={selectedIds.length === 0}
                activeOpacity={0.8}
              >
                <Text style={styles.selectBarDeleteText}>删除</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索角色名或标签"
            placeholderTextColor={theme.colors.textFaint}
          />
          {visibleCharacters.length === 0 && (editMode || visibleGroups.length === 0) ? (
            <Text style={styles.emptyHint}>没有匹配的角色，换个关键词试试。</Text>
          ) : null}
          <View style={styles.characterGrid}>
            {visibleCharacters.map(item => {
              const selected = !activeIsGroup && item.id === activeId;
              const checked = selectedIds.includes(item.id);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.characterCard, selected && styles.characterCardActive]}
                  onPress={() => (editMode ? (item.id === 'default' ? null : toggleSelect(item.id)) : onSwitch(item.id))}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={`切换到角色 ${item.name || '未命名角色'}`}
                  accessibilityState={{ selected }}
                >
                  <View style={styles.characterCardImageWrap}>
                    {item.avatarUri ? (
                      <Image source={{ uri: item.avatarUri }} style={styles.characterCardImage} />
                    ) : (
                      <View style={styles.characterCardFallback}>
                        <Text style={styles.characterCardFallbackText}>
                          {(item.name || '?').charAt(0)}
                        </Text>
                      </View>
                    )}
                    {editMode && item.id !== 'default' ? (
                      <View style={[styles.characterCardCheck, checked && styles.characterCardCheckOn]}>
                        <Ionicons name={checked ? 'checkmark' : 'ellipse-outline'} size={15} color={theme.colors.primaryContrast} />
                      </View>
                    ) : selected ? (
                      <View style={styles.characterCardBadge}>
                        <Text style={styles.characterCardBadgeText}>当前</Text>
                      </View>
                    ) : null}
                    {item.id !== 'default' && !editMode ? (
                      <>
                        <TouchableOpacity
                          style={styles.characterCardPin}
                          onPress={() => onTogglePin(item)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel={item.pinned ? '取消置顶' : '置顶角色'}
                        >
                          <Ionicons
                            name={item.pinned ? 'star' : 'star-outline'}
                            size={15}
                            color={item.pinned ? theme.colors.star : theme.colors.text}
                          />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.characterCardDelete}
                          onPress={() => onDeleteCharacter(item)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel="删除角色"
                        >
                          <Ionicons name="trash-outline" size={15} color={theme.colors.text} />
                        </TouchableOpacity>
                      </>
                    ) : null}
                  </View>
                  <View style={styles.characterCardNameBar}>
                    <Text style={styles.characterCardName} numberOfLines={1}>
                      {item.name || '未命名角色'}
                    </Text>
                  </View>
                  {item.tags && item.tags.length > 0 ? (
                    <View style={styles.characterCardTags}>
                      {item.tags.slice(0, 3).map(tag => (
                        <Text key={tag} style={styles.characterCardTag} numberOfLines={1}>{tag}</Text>
                      ))}
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            {!editMode && visibleGroups.map(group => {
              const selected = group.id === activeSessionId;
              return (
                <TouchableOpacity
                  key={`group-${group.id}`}
                  style={[styles.characterCard, selected && styles.characterCardActive]}
                  onPress={() => onOpenGroup(group)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={`进入群聊 ${groupNameOf(group)}`}
                  accessibilityState={{ selected }}
                >
                  <View style={styles.characterCardImageWrap}>
                    {group.avatarUri ? (
                      <Image source={{ uri: group.avatarUri }} style={styles.characterCardImage} />
                    ) : (
                      <View style={styles.characterCardFallback}>
                        <Ionicons name="people" size={24} color={theme.colors.primarySoft} />
                      </View>
                    )}
                    {selected ? (
                      <View style={styles.characterCardBadge}>
                        <Text style={styles.characterCardBadgeText}>当前</Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.characterCardNameBar}>
                    <Text style={styles.characterCardName} numberOfLines={1}>
                      {groupNameOf(group)}
                    </Text>
                  </View>
                  <View style={styles.characterCardTags}>
                    <Text style={styles.characterCardTag} numberOfLines={1}>
                      {`${(group.members || []).length} 人群聊`}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="create-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>基本信息</Text>
          </View>
          <FieldLabel style={styles.label}>角色名</FieldLabel>
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="例如：严谨的代码助手"
          />
          <TouchableOpacity
            style={[styles.importButton, (importing || !loaded) && styles.buttonDisabled]}
            onPress={importCard}
            disabled={importing || !loaded}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.importButtonText}>
              {importing ? '导入中...' : '导入角色卡'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.importHint}>支持导入 PNG 或 JSON 格式的角色卡文件。</Text>
          <TopicButton
            style={styles.topicButton}
            onPress={() => setTopic('character-card')}
            accessibilityLabel="查看角色卡获取教学"
          />

          <Text style={styles.fieldLabel}>角色头像</Text>
          <View style={styles.imageRow}>
            <View style={styles.avatarBox}>
              {avatarPreview ? (
                <Image source={{ uri: avatarPreview }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarPlaceholderText}>
                    {(name || character.name || '?').charAt(0)}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.imageActions}>
              <TouchableOpacity style={styles.smallButton} onPress={pickAvatar} activeOpacity={0.8}>
                <Text style={styles.smallButtonText}>{avatarPreview ? '更换' : '选择头像'}</Text>
              </TouchableOpacity>
              {avatarPreview ? (
                <TouchableOpacity onPress={() => setAvatarPreview(null)} hitSlop={8}>
                  <Text style={styles.removeText}>清除</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <Text style={styles.fieldLabel}>背景图</Text>
          <View style={styles.imageRow}>
            {bgPreview ? (
              <Image source={{ uri: bgPreview }} style={styles.bgPreview} />
            ) : null}
            <View style={styles.imageActions}>
              <TouchableOpacity style={styles.smallButton} onPress={pickBg} activeOpacity={0.8}>
                <Text style={styles.smallButtonText}>{bgPreview ? '更换' : '选择背景'}</Text>
              </TouchableOpacity>
              {bgPreview ? (
                <TouchableOpacity onPress={clearBgImage} hitSlop={8}>
                  <Text style={styles.removeText}>清除</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={onExport}
            disabled={exporting || !loaded}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="share-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>
                {exporting ? '导出中...' : '导出角色卡'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>

        </Card>

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="sparkles-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>人设设定</Text>
          </View>
          <FieldLabel style={styles.label}>开场白</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={firstMes}
            onChangeText={setFirstMes}
            placeholder="角色登场时的第一句话"
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>备用开场白</FieldLabel>
          {alternateGreetings.map((item, index) => (
            <View key={`greeting-${index}`} style={styles.greetingRow}>
              <TextField
                style={[styles.multilineSmall, styles.greetingInput]}
                value={item}
                onChangeText={value => updateGreeting(index, value)}
                placeholder={`备用开场白 ${index + 1}`}
                multiline
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={styles.greetingRemove}
                onPress={() => removeGreeting(index)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="删除备用开场白"
              >
                <Ionicons name="close" size={16} color={theme.colors.dangerSoft} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={styles.secondaryButton} onPress={addGreeting} activeOpacity={0.8}>
            <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.secondaryButtonText}>添加备用开场白</Text>
          </TouchableOpacity>
          <FieldLabel style={styles.label}>人设 / 系统提示词</FieldLabel>
          <TextField
            style={styles.multiline}
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder="描述角色的语气、知识和回答方式"
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>角色描述</FieldLabel>
          <TextField
            style={styles.multiline}
            value={description}
            onChangeText={setDescription}
            placeholder="角色的背景、外貌与身份设定"
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>性格</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={personality}
            onChangeText={setPersonality}
            placeholder="角色的性格特点"
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>场景</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={scenario}
            onChangeText={setScenario}
            placeholder="剧情发生的背景与情境"
            multiline
            textAlignVertical="top"
          />

          <FieldLabel style={styles.label}>对话示例</FieldLabel>
          <TextField
            style={styles.multiline}
            value={mesExample}
            onChangeText={setMesExample}
            placeholder="<START>\n{{user}}: 你好\n{{char}}: 你好呀"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.fieldHint}>对话示例会作为示范注入系统提示词，可用 {`{{user}}`} 与 {`{{char}}`} 占位。</Text>

          <FieldLabel style={styles.label}>标签</FieldLabel>
          <View style={styles.tagRow}>
            {tags.map(tag => (
              <TouchableOpacity key={tag} style={styles.tagChip} onPress={() => removeTag(tag)} activeOpacity={0.8}>
                <Text style={styles.tagChipText}>{tag}</Text>
                <Ionicons name="close" size={12} color={theme.colors.primarySoft} />
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.tagInputRow}>
            <TextField
              style={styles.tagInput}
              value={tagDraft}
              onChangeText={setTagDraft}
              onSubmitEditing={addTag}
              placeholder="输入标签后回车添加"
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.tagAdd} onPress={addTag} activeOpacity={0.8}>
              <Ionicons name="add" size={18} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
          </View>
        </Card>

        <TouchableOpacity
          style={[styles.button, !loaded && styles.buttonDisabled, styles.saveButton]}
          onPress={save}
          disabled={!loaded}
          activeOpacity={0.85}
        >
          <Ionicons name="save-outline" size={17} color={theme.colors.text} />
          <Text style={styles.buttonText}>保存角色</Text>
        </TouchableOpacity>

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="albums-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>角色数据</Text>
          </View>

          {card.creatorNotes || card.postHistoryInstructions ? (
            <View style={styles.dataSection}>
              <Text style={styles.dataTitle}>其他资料</Text>
              <DataField label="作者注释" value={card.creatorNotes} />
              <DataField label="历史后指令" value={card.postHistoryInstructions} />
            </View>
          ) : null}

          {card.tags?.length ? (
            <View style={styles.dataSection}>
              <Text style={styles.dataTitle}>标签</Text>
              <View style={styles.tagRow}>
                {card.tags.map((tag, index) => (
                  <View key={`${tag}-${index}`} style={styles.tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          <CollapsibleSection
            title="世界书"
            icon="book-outline"
            count={worldInfo.length}
            expanded={expandedWorld}
            onToggle={() => setExpandedWorld(value => !value)}
            onAdd={addWorldEntry}
            addLabel="添加世界书条目"
          >
            {worldInfo.length === 0 ? (
              <Text style={styles.dataEmpty}>暂无世界书条目。</Text>
            ) : (
              worldInfo.map((entry, index) => (
                <SummaryRow
                  key={entry.id}
                  title={entry.comment || `条目 ${index + 1}`}
                  meta={worldEntryMeta(entry)}
                  enabled={entry.enabled}
                  onPress={() => setEditingWorldId(entry.id)}
                />
              ))
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="正则脚本"
            icon="code-slash-outline"
            count={regexScripts.length}
            expanded={expandedRegex}
            onToggle={() => setExpandedRegex(value => !value)}
            onAdd={addRegexScript}
            addLabel="添加正则脚本"
          >
            {regexScripts.length === 0 ? (
              <Text style={styles.dataEmpty}>暂无正则脚本。</Text>
            ) : (
              regexScripts.map((script, index) => (
                <SummaryRow
                  key={script.id}
                  title={script.name || `正则 ${index + 1}`}
                  meta={script.placementLabel || ''}
                  enabled={script.enabled}
                  onPress={() => setEditingRegexId(script.id)}
                />
              ))
            )}
          </CollapsibleSection>

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={() => setPresetPanelOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="list-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>全局预设</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
        </Card>

        <View style={{ height: 24 }} />
      </ScrollView>

      <Modal
        visible={groupPanelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupPanelOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>创建群聊</Text>
            <FieldLabel style={styles.label}>群名（留空自动生成）</FieldLabel>
            <TextField
              value={groupName}
              onChangeText={setGroupName}
              placeholder="例如：周末闲聊群"
              editable={!creatingGroup}
            />
            <FieldLabel style={styles.label}>{`选择成员（已选 ${groupSelected.length} / 2-8）`}</FieldLabel>
            <ScrollView style={styles.groupList} keyboardShouldPersistTaps="handled">
              {characters.map(item => {
                const selected = groupSelected.includes(item.id);
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.groupRow}
                    onPress={() => toggleGroupMember(item.id)}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name={selected ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={selected ? theme.colors.primaryMuted : theme.colors.textFaint}
                    />
                    {item.avatarUri ? (
                      <Image source={{ uri: item.avatarUri }} style={styles.groupAvatar} />
                    ) : (
                      <View style={[styles.groupAvatar, styles.groupAvatarFallback]}>
                        <Text style={styles.avatarPlaceholderText}>
                          {String(item.name || '?').charAt(0)}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.groupName} numberOfLines={1}>
                      {item.name || '未命名角色'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {groupSelected.length > 0 ? (
              <>
                <FieldLabel style={styles.label}>群头像（可从成员选择）</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupAvatarUri && styles.groupPickChipActive]}
                    onPress={() => setGroupAvatarUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupAvatarUri && styles.groupPickTextActive]}>不使用</Text>
                  </TouchableOpacity>
                  {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                    const uri = String(item.avatarUri || '');
                    const active = uri && groupAvatarUri === uri;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                        onPress={() => setGroupAvatarUri(uri)}
                        activeOpacity={0.8}
                      >
                        {uri ? (
                          <Image source={{ uri }} style={styles.groupPickAvatar} />
                        ) : (
                          <View style={[styles.groupPickAvatar, styles.groupPickAvatarFallback]}>
                            <Text style={styles.avatarPlaceholderText}>{String(item.name || '?').charAt(0)}</Text>
                          </View>
                        )}
                        <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                          {item.name || '未命名'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <FieldLabel style={styles.label}>群背景（可从成员背景选择）</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupBgUri && styles.groupPickChipActive]}
                    onPress={() => setGroupBgUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupBgUri && styles.groupPickTextActive]}>不使用</Text>
                  </TouchableOpacity>
                  {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                    const uri = String(item.bgUri || '');
                    const active = uri && groupBgUri === uri;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                        onPress={() => {
                          if (!uri) {
                            Alert.alert('无法选择', `「${item.name || '该角色'}」没有背景图。`);
                            return;
                          }
                          setGroupBgUri(uri);
                        }}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                          {item.name || '未命名'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}
            <View style={styles.presetModalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setGroupPanelOpen(false)}
                disabled={creatingGroup}
                activeOpacity={0.8}
              >
                <Text style={[styles.selectButtonText, styles.selectButtonTextGhost]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, creatingGroup && styles.buttonDisabled]}
                onPress={onCreateGroup}
                disabled={creatingGroup}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>
                  {creatingGroup ? '创建中...' : '创建'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <PresetPanel
        visible={presetPanelOpen}
        onClose={() => setPresetPanelOpen(false)}
      />

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />

      <Modal
        visible={!!editingWorldEntry}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingWorldId(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>编辑世界书条目</Text>
              <TouchableOpacity
                onPress={() => setEditingWorldId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>完成</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              {editingWorldEntry ? (
                <WorldEntryEditor
                  entry={editingWorldEntry}
                  index={editingWorldIndex}
                  onChange={patch => updateWorldEntry(editingWorldEntry.id, patch)}
                  onRemove={() => {
                    removeWorldEntry(editingWorldEntry.id);
                    setEditingWorldId(null);
                  }}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={!!editingRegexEntry}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingRegexId(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>编辑正则脚本</Text>
              <TouchableOpacity
                onPress={() => setEditingRegexId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>完成</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              {editingRegexEntry ? (
                <RegexEntryEditor
                  script={editingRegexEntry}
                  index={editingRegexIndex}
                  onChange={patch => updateRegexScript(editingRegexEntry.id, patch)}
                  onRemove={() => {
                    removeRegexScript(editingRegexEntry.id);
                    setEditingRegexId(null);
                  }}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 18 },
  pageHeader: { marginTop: 4, marginBottom: 14 },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: '800', marginBottom: 6 },
  hint: { color: theme.colors.textFaint, fontSize: 13, lineHeight: 19 },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '800', marginLeft: 8 },
  presetEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  presetEntryLeft: { flexDirection: 'row', alignItems: 'center' },
  presetEntryText: { color: theme.colors.textMuted, fontSize: 15, marginLeft: 10 },
  groupList: { maxHeight: 300, marginTop: 4 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface,
  },
  groupAvatar: { width: 34, height: 34, borderRadius: 9, marginLeft: 10, backgroundColor: theme.colors.surfaceBorder },
  groupAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  groupName: { color: theme.colors.textMuted, fontSize: 14, marginLeft: 10, flex: 1 },
  groupPickRow: { flexGrow: 0, marginTop: 2 },
  groupPickChip: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  groupPickChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySoft },
  groupPickAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.colors.surfaceBorder },
  groupPickAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  groupPickText: { color: theme.colors.textMuted, fontSize: 12, marginTop: 4 },
  groupPickTextActive: { color: theme.colors.primary, fontWeight: '700' },
  countBadge: {
    marginLeft: 8,
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 11,
    backgroundColor: theme.colors.primaryAlpha(0.18),
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: { color: theme.colors.primarySoft, fontSize: 11, fontWeight: '700' },

  label: { color: theme.colors.textMuted, marginTop: 14, marginBottom: 6, fontWeight: '700', fontSize: 13 },
  fieldLabel: { color: theme.colors.textFaint, fontSize: 12, marginTop: 12, marginBottom: 6, fontWeight: '600' },
  inputSmall: { paddingVertical: 9, paddingHorizontal: 11 },
  multiline: { minHeight: 160, maxHeight: 340, paddingTop: 12 },
  multilineSmall: { minHeight: 80, maxHeight: 220, paddingTop: 12 },
  contentInput: { minHeight: 80, maxHeight: 220 },
  codeInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
  },

  button: {
    flexDirection: 'row',
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: theme.colors.text, fontWeight: '800', marginLeft: 8, fontSize: 15 },
  buttonDisabled: { opacity: 0.45 },
  saveButton: { marginBottom: 12 },
  searchInput: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    fontSize: fonts.scaled(13),
    marginTop: 10,
  },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingHorizontal: 4,
  },
  selectBarText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(14), fontWeight: '700' },
  selectBarCount: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  selectBarDelete: {
    backgroundColor: theme.colors.danger,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  selectBarDeleteText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700' },
  emptyHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 12, textAlign: 'center' },
  characterCardCheck: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: theme.colors.primaryContrast,
  },
  characterCardCheckOn: { backgroundColor: theme.colors.primary },
  characterCardPin: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterCardTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  characterCardTag: {
    color: theme.colors.primarySoft,
    backgroundColor: `${theme.colors.primary}33`,
    fontSize: fonts.scaled(10),
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginRight: 4,
    marginTop: 4,
    overflow: 'hidden',
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${theme.colors.primary}33`,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 8,
    marginBottom: 8,
  },
  tagChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginRight: 4 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center' },
  greetingRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  greetingInput: { flex: 1, marginBottom: 0 },
  greetingRemove: { paddingHorizontal: 10, paddingVertical: 10 },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${theme.colors.primary}1f`,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}73`,
    paddingVertical: 11,
    borderRadius: 10,
    marginTop: 4,
    marginBottom: 4,
  },
  secondaryButtonText: { color: theme.colors.primarySoft, fontWeight: '700', marginLeft: 6, fontSize: fonts.scaled(13) },
  tagInput: { flex: 1, minHeight: 40, marginRight: 8 },
  tagAdd: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    marginLeft: 10,
  },
  selectButtonGhost: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  selectButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  selectButtonTextGhost: { color: theme.colors.text },

  importButton: {
    flexDirection: 'row',
    backgroundColor: theme.colors.primaryAlpha(0.12),
    borderWidth: 1,
    borderColor: theme.colors.primary,
    paddingVertical: 11,
    borderRadius: 10,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importButtonText: { color: theme.colors.primarySoft, fontWeight: '700', marginLeft: 8 },
  importHint: { color: theme.colors.textFaint, fontSize: 12, marginTop: 8 },
  topicButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
  },

  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.12),
    borderWidth: 1,
    borderColor: theme.colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  pillButtonText: { color: theme.colors.primarySoft, fontWeight: '700', fontSize: 13, marginLeft: 4 },

  characterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  characterCard: {
    width: '48%',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
    marginTop: tokens.spacing.sm + 2,
    ...tokens.elevation(1, theme),
  },
  characterCardActive: {
    borderColor: theme.colors.primary,
  },
  characterCardImageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: theme.colors.surfaceBorder,
  },
  characterCardImage: { width: '100%', height: '100%' },
  characterCardFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.18),
  },
  characterCardFallbackText: { color: theme.colors.primarySoft, fontSize: 34, fontWeight: '800' },
  characterCardBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.radius.pill,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 2,
  },
  characterCardBadgeText: { color: theme.colors.primaryContrast, fontSize: 11, fontWeight: '700' },
  characterCardDelete: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: tokens.radius.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterCardNameBar: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    paddingVertical: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterCardName: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: '700',
    maxWidth: '100%',
  },
  removeText: { color: theme.colors.dangerSoft, fontWeight: '700' },

  imageRow: { flexDirection: 'row', alignItems: 'center' },
  imageActions: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarBox: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
    marginRight: 12,
    borderWidth: 2,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
  },
  avatarImage: { width: 56, height: 56, borderRadius: 28 },
  avatarPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.primaryAlpha(0.14),
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: theme.colors.primarySoft, fontSize: 22, fontWeight: '800' },
  bgPreview: {
    width: 60,
    height: 60,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  smallButton: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 12,
  },
  smallButtonText: { color: theme.colors.primarySoft, fontWeight: '700', fontSize: 13 },

  dataSection: { marginTop: 16 },
  dataTitle: { color: theme.colors.primarySoft, fontWeight: '800', fontSize: 13, marginBottom: 8 },
  sectionCard: {
    marginTop: 12,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center' },
  sectionTitle: { color: theme.colors.primarySoft, fontWeight: '800', marginLeft: 8, fontSize: 13 },
  sectionBody: { paddingBottom: 10 },
  addButton: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  addButtonText: { color: theme.colors.primarySoft, fontWeight: '700', marginLeft: 6 },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
  tag: {
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: 1,
    borderColor: theme.colors.primaryMutedAlpha(0.3),
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginRight: 6,
    marginBottom: 6,
    maxWidth: '100%',
    flexShrink: 1,
  },
  tagText: { color: theme.colors.primarySoft, fontSize: 12, lineHeight: 18, fontWeight: '600', flexShrink: 1 },

  dataField: { marginBottom: 10 },
  dataFieldLabel: { color: theme.colors.textFaint, fontSize: 12, marginBottom: 3 },
  dataFieldValue: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  dataEmpty: { color: theme.colors.textFaint, fontSize: 13, paddingVertical: 6 },
  dataMeta: { color: theme.colors.textFaint, fontSize: 12, lineHeight: 18 },

  entryCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.colors.surface,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  entryTitle: { color: theme.colors.text, fontWeight: '700', flex: 1, marginRight: 8 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  toggleLabel: { color: theme.colors.textMuted, fontSize: 14 },
  cycleRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  cycleButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  cycleButtonText: { color: theme.colors.primarySoft, fontSize: 13, fontWeight: '700' },
  numberRow: { flexDirection: 'row', marginTop: 4 },
  numberField: { flex: 1, marginRight: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  chip: {
    backgroundColor: theme.colors.surface,
    borderRadius: 15,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { color: theme.colors.textFaint, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: theme.colors.text },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  summaryInfo: { flex: 1, marginRight: 8 },
  summaryTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 14 },
  summaryMeta: { color: theme.colors.textFaint, fontSize: 12, marginTop: 2 },
  statusBadge: {
    backgroundColor: 'rgba(136,136,136,0.18)',
    borderRadius: 9,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 6,
  },
  statusBadgeText: { color: theme.colors.textFaint, fontSize: 11, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 20,
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 16,
    padding: 16,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: theme.colors.surface,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  modalTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '800' },
  modalDone: { color: theme.colors.primaryMuted, fontWeight: '800' },
  modalBody: { flexGrow: 0 },
});
