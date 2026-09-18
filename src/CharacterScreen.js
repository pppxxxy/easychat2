import React, { useEffect, useRef, useState } from 'react';
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
import { useApp } from './context/AppContext';
import { compileRegex } from './regexEngine';
import { maskSecrets } from './secrets';

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
    mesExample: fields.mesExample || '',
    creatorNotes: fields.creatorNotes || '',
    postHistoryInstructions: fields.postHistoryInstructions || '',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    worldInfo: Array.isArray(card.worldInfo) ? card.worldInfo : [],
    regexScripts: Array.isArray(card.regexScripts) ? card.regexScripts : [],
  };
}

function DataField({ label, value }) {
  if (!value) return null;
  return (
    <View style={styles.dataField}>
      <Text style={styles.dataFieldLabel}>{label}</Text>
      <Text style={styles.dataFieldValue} numberOfLines={6}>{value}</Text>
    </View>
  );
}

function ToggleRow({ label, value, onValueChange }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: '#3a3a55', true: '#6c63ff' }}
        thumbColor="#f2f2f7"
      />
    </View>
  );
}

function Chip({ label, active, onPress }) {
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
      <TextInput
        style={[styles.input, styles.inputSmall]}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onEndEditing={commit}
        keyboardType="number-pad"
        placeholder={label}
        placeholderTextColor="#888"
      />
    </View>
  );
}

function CollapsibleSection({ title, count, expanded, onToggle, onAdd, addLabel, icon, children }) {
  return (
    <View style={styles.sectionCard}>
      <TouchableOpacity style={styles.sectionHeader} onPress={onToggle} activeOpacity={0.8}>
        <View style={styles.sectionTitleRow}>
          {icon ? <Ionicons name={icon} size={15} color="#8b85ff" /> : null}
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color="#8b85ff" />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.sectionBody}>
          {children}
          {onAdd ? (
            <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color="#c8c4ff" />
              <Text style={styles.addButtonText}>{addLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function WorldEntryEditor({ entry, index, onChange, onRemove }) {
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
      <TextInput
        style={[styles.input, styles.inputSmall]}
        value={entry.comment}
        onChangeText={comment => onChange({ comment })}
        placeholder="世界书条目名称"
        placeholderTextColor="#888"
      />
      <Text style={styles.fieldLabel}>触发关键词（逗号分隔）</Text>
      <TextInput
        style={[styles.input, styles.inputSmall]}
        value={keys.join(', ')}
        onChangeText={text => onChange({ keys: splitKeywords(text) })}
        placeholder="关键词一, 关键词二"
        placeholderTextColor="#888"
      />
      <Text style={styles.fieldLabel}>内容</Text>
      <TextInput
        style={[styles.input, styles.contentInput]}
        value={entry.content}
        onChangeText={content => onChange({ content })}
        placeholder="命中后注入提示词的内容"
        placeholderTextColor="#888"
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
      <TextInput
        style={[styles.input, styles.inputSmall]}
        value={script.name}
        onChangeText={name => onChange({ name })}
        placeholder="正则脚本名称"
        placeholderTextColor="#888"
      />
      <Text style={styles.fieldLabel}>匹配表达式</Text>
      <TextInput
        style={[styles.input, styles.contentInput, styles.codeInput]}
        value={script.findRegex}
        onChangeText={findRegex => onChange({ findRegex })}
        placeholder="例如：\\bfoo\\b"
        placeholderTextColor="#888"
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.fieldLabel}>替换为</Text>
      <TextInput
        style={[styles.input, styles.contentInput, styles.codeInput]}
        value={script.replaceString}
        onChangeText={replaceString => onChange({ replaceString })}
        placeholder="替换后的文本，可留空表示删除"
        placeholderTextColor="#888"
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.fieldLabel}>flags</Text>
      <TextInput
        style={[styles.input, styles.inputSmall, styles.codeInput]}
        value={script.flags}
        onChangeText={flags => onChange({ flags })}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="g"
        placeholderTextColor="#888"
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
      <Ionicons name="chevron-forward" size={16} color="#6c63ff" />
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
    addCharacter,
    deleteCharacter,
  } = useApp();
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMes, setFirstMes] = useState('');
  const [worldInfo, setWorldInfo] = useState([]);
  const [regexScripts, setRegexScripts] = useState([]);
  const [expandedWorld, setExpandedWorld] = useState(false);
  const [expandedRegex, setExpandedRegex] = useState(false);
  const [editingWorldId, setEditingWorldId] = useState(null);
  const [editingRegexId, setEditingRegexId] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [bgPreview, setBgPreview] = useState(null);
  const [importing, setImporting] = useState(false);
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
    setScenario(character.scenario || '');
    setFirstMes(character.firstMes || '');
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
      scenario: scenario.trim(),
      firstMes: firstMes.trim(),
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

  const onSwitch = id => {
    switchCharacter(id).catch(() => {
      Alert.alert('切换失败', '请检查存储空间或权限。');
    });
  };

  const onNewCharacter = async () => {
    if (!loaded) return;
    try {
      await addCharacter({ name: '新角色' });
    } catch (error) {
      Alert.alert('新建失败', '请检查存储空间或权限。');
    }
  };

  const onDeleteCharacter = item => {
    Alert.alert(
      '删除角色',
      `确定删除「${item.name || '未命名角色'}」及其聊天记录吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            deleteCharacter(item.id).catch(error => {
              Alert.alert('删除失败', error?.message || '请稍后重试。');
            });
          },
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
          <Text style={styles.hint}>聊天时会把这里的设定作为系统提示词发送给模型。</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="people-outline" size={16} color="#8b85ff" />
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
              <Ionicons name="add" size={15} color="#c8c4ff" />
              <Text style={styles.pillButtonText}>新建</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.characterGrid}>
            {characters.map(item => {
              const selected = item.id === activeId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.characterCard, selected && styles.characterCardActive]}
                  onPress={() => onSwitch(item.id)}
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
                    {selected ? (
                      <View style={styles.characterCardBadge}>
                        <Text style={styles.characterCardBadgeText}>当前</Text>
                      </View>
                    ) : null}
                    {item.id !== 'default' ? (
                      <TouchableOpacity
                        style={styles.characterCardDelete}
                        onPress={() => onDeleteCharacter(item)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel="删除角色"
                      >
                        <Ionicons name="trash-outline" size={15} color="#ffffff" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <View style={styles.characterCardNameBar}>
                    <Text style={styles.characterCardName} numberOfLines={1}>
                      {item.name || '未命名角色'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="create-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>基本信息</Text>
          </View>
          <Text style={styles.label}>角色名</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="例如：严谨的代码助手"
            placeholderTextColor="#888"
          />
          <TouchableOpacity
            style={[styles.importButton, (importing || !loaded) && styles.buttonDisabled]}
            onPress={importCard}
            disabled={importing || !loaded}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={16} color="#c8c4ff" />
            <Text style={styles.importButtonText}>
              {importing ? '导入中...' : '导入角色卡'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.importHint}>支持导入 PNG 或 JSON 格式的角色卡文件。</Text>

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
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="sparkles-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>人设设定</Text>
          </View>
          <Text style={styles.label}>开场白</Text>
          <TextInput
            style={[styles.input, styles.multilineSmall]}
            value={firstMes}
            onChangeText={setFirstMes}
            placeholder="角色登场时的第一句话"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.label}>人设 / 系统提示词</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder="描述角色的语气、知识和回答方式"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.label}>角色描述</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="角色的背景、外貌与身份设定"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.label}>性格</Text>
          <TextInput
            style={[styles.input, styles.multilineSmall]}
            value={personality}
            onChangeText={setPersonality}
            placeholder="角色的性格特点"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.label}>场景</Text>
          <TextInput
            style={[styles.input, styles.multilineSmall]}
            value={scenario}
            onChangeText={setScenario}
            placeholder="剧情发生的背景与情境"
            placeholderTextColor="#888"
            multiline
            textAlignVertical="top"
          />
        </View>

        <TouchableOpacity
          style={[styles.button, !loaded && styles.buttonDisabled]}
          onPress={save}
          disabled={!loaded}
          activeOpacity={0.85}
        >
          <Ionicons name="save-outline" size={17} color="#fff" />
          <Text style={styles.buttonText}>保存角色</Text>
        </TouchableOpacity>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="albums-outline" size={16} color="#8b85ff" />
            <Text style={styles.cardTitle}>角色数据</Text>
          </View>

          {card.mesExample || card.creatorNotes || card.postHistoryInstructions ? (
            <View style={styles.dataSection}>
              <Text style={styles.dataTitle}>其他资料</Text>
              <DataField label="对话示例" value={card.mesExample} />
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
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

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

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#1a1a2e' },
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 18 },
  pageHeader: { marginTop: 4, marginBottom: 6 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 6 },
  hint: { color: '#9a9ab5', fontSize: 13, lineHeight: 19 },

  card: {
    backgroundColor: '#232338',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#35354f',
    padding: 14,
    marginTop: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.16,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '800', marginLeft: 8 },
  countBadge: {
    marginLeft: 8,
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 11,
    backgroundColor: 'rgba(108,99,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: { color: '#c8c4ff', fontSize: 11, fontWeight: '700' },

  label: { color: '#e6e6f2', marginTop: 14, marginBottom: 6, fontWeight: '700', fontSize: 13 },
  fieldLabel: { color: '#9a9ab5', fontSize: 12, marginTop: 12, marginBottom: 6, fontWeight: '600' },
  input: {
    backgroundColor: '#2d2d44',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a58',
    fontSize: 14,
  },
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
    backgroundColor: '#6c63ff',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '800', marginLeft: 8, fontSize: 15 },
  buttonDisabled: { opacity: 0.45 },

  importButton: {
    flexDirection: 'row',
    backgroundColor: 'rgba(108,99,255,0.12)',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 11,
    borderRadius: 10,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importButtonText: { color: '#c8c4ff', fontWeight: '700', marginLeft: 8 },
  importHint: { color: '#7d7d99', fontSize: 12, marginTop: 8 },

  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(108,99,255,0.12)',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  pillButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13, marginLeft: 4 },

  characterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  characterCard: {
    width: '48%',
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'hidden',
    marginTop: 10,
  },
  characterCardActive: {
    borderColor: '#6c63ff',
  },
  characterCardImageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#3a3a58',
  },
  characterCardImage: { width: '100%', height: '100%' },
  characterCardFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(108,99,255,0.18)',
  },
  characterCardFallbackText: { color: '#c8c4ff', fontSize: 34, fontWeight: '800' },
  characterCardBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#6c63ff',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  characterCardBadgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  characterCardDelete: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterCardNameBar: {
    backgroundColor: '#ffffff',
    paddingVertical: 7,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterCardName: {
    color: '#1a1a2e',
    fontSize: 13,
    fontWeight: '700',
    maxWidth: '100%',
  },
  removeText: { color: '#ff9b9b', fontWeight: '700' },

  imageRow: { flexDirection: 'row', alignItems: 'center' },
  imageActions: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarBox: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2d2d44',
    overflow: 'hidden',
    marginRight: 12,
    borderWidth: 2,
    borderColor: 'rgba(139,133,255,0.45)',
  },
  avatarImage: { width: 56, height: 56, borderRadius: 28 },
  avatarPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(108,99,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: '#c8c4ff', fontSize: 22, fontWeight: '800' },
  bgPreview: {
    width: 60,
    height: 60,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  smallButton: {
    backgroundColor: '#2d2d44',
    borderWidth: 1,
    borderColor: '#6c63ff',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 12,
  },
  smallButtonText: { color: '#c8c4ff', fontWeight: '700', fontSize: 13 },

  dataSection: { marginTop: 16 },
  dataTitle: { color: '#c8c4ff', fontWeight: '800', fontSize: 13, marginBottom: 8 },
  sectionCard: {
    marginTop: 12,
    backgroundColor: '#1f1f33',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d2d44',
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
  sectionTitle: { color: '#c8c4ff', fontWeight: '800', marginLeft: 8, fontSize: 13 },
  sectionBody: { paddingBottom: 10 },
  addButton: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#6c63ff',
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  addButtonText: { color: '#c8c4ff', fontWeight: '700', marginLeft: 6 },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap' },
  tag: {
    backgroundColor: 'rgba(108,99,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(139,133,255,0.3)',
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginRight: 6,
    marginBottom: 6,
    maxWidth: '100%',
    flexShrink: 1,
  },
  tagText: { color: '#c8c4ff', fontSize: 12, lineHeight: 18, fontWeight: '600', flexShrink: 1 },

  dataField: { marginBottom: 10 },
  dataFieldLabel: { color: '#7d7d99', fontSize: 12, marginBottom: 3 },
  dataFieldValue: { color: '#e6e6ef', fontSize: 14, lineHeight: 20 },
  dataEmpty: { color: '#7d7d99', fontSize: 13, paddingVertical: 6 },
  dataMeta: { color: '#9a9ab5', fontSize: 12, lineHeight: 18 },

  entryCard: {
    backgroundColor: '#24243b',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2d2d44',
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  entryTitle: { color: '#fff', fontWeight: '700', flex: 1, marginRight: 8 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  toggleLabel: { color: '#d9d9e6', fontSize: 14 },
  cycleRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  cycleButton: {
    backgroundColor: '#2d2d44',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  cycleButtonText: { color: '#c8c4ff', fontSize: 13, fontWeight: '700' },
  numberRow: { flexDirection: 'row', marginTop: 4 },
  numberField: { flex: 1, marginRight: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  chip: {
    backgroundColor: '#2d2d44',
    borderRadius: 15,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  chipActive: { backgroundColor: '#6c63ff', borderColor: '#6c63ff' },
  chipText: { color: '#9a9ab5', fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: '#fff' },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d2d44',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#3a3a58',
  },
  summaryInfo: { flex: 1, marginRight: 8 },
  summaryTitle: { color: '#fff', fontWeight: '700', fontSize: 14 },
  summaryMeta: { color: '#7d7d99', fontSize: 12, marginTop: 2 },
  statusBadge: {
    backgroundColor: 'rgba(136,136,136,0.18)',
    borderRadius: 9,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 6,
  },
  statusBadgeText: { color: '#9a9ab5', fontSize: 11, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 20,
  },
  modalSheet: {
    backgroundColor: '#232338',
    borderRadius: 16,
    padding: 16,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: '#2d2d44',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  modalDone: { color: '#8b85ff', fontWeight: '800' },
  modalBody: { flexGrow: 0 },
});
