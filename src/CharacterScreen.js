import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Buffer } from 'buffer';

import {
  buildSystemPrompt,
  createRegexScript,
  createWorldEntry,
  parseCardFromJson,
  parseCardFromPng,
} from './character/cardParser.js';
import { exportCardFile } from './character/cardExporter.js';
import ChapterModal from './books/ChapterModal.js';
import GreetingPickerModal from './GreetingPickerModal.js';
import { listGreetingCandidates } from './character/cardGreetings.js';
import { Card, FieldHint, FieldLabel, TextField, TopicButton } from './ui/index.js';
import { useApp } from './context/AppContext.js';
import { selectSessionsForCharacters } from './context/sessionLibrary.js';
import { useNavigation } from '@react-navigation/native';
import PresetPanel from './PresetPanel.js';
import ScrollScrubber, { getScrollRange } from './chat/ScrollScrubber.js';
import { compileRegex, isUnsafeRegexPattern } from './prompt/regexEngine.js';
import { getUnsafeWorldEntryKeys } from './prompt/lorebook.js';
import { maskSecrets } from './storage/secrets.js';
import {
  createGroupSession,
  deleteMomentsForCharacterDeletion,
  getMomentsStatus,
  markMediaWrite,
  getUserProfile,
  saveCardForge,
  saveCharacterEditDraft,
  takeCharacterEditDraft,
  clearCharacterEditDraft,
} from './storage.js';
import { isRecentMediaUri } from './storage/mediaProtection.js';
import { countMomentsForCharacterDeletion } from './moments/moments.js';
import { createForgeState, draftFromCharacter } from './cardForge/forge.js';
import { isFormDirty, setCharacterEditGuard } from './character/characterEditGuard.js';
import { isValidAigcMeta } from './aigc/attribution.js';
import { useTheme } from './theme/ThemeContext.js';
import { createCharacterStyles } from './character/characterStyles.js';
import {
  CollapsibleSection,
  DataField,
  RegexEntryEditor,
  SummaryRow,
  WorldEntryEditor,
} from './character/editors.js';
import {
  CHARACTER_LIST_COLLAPSE_LIMIT,
  MAX_IMPORT_BYTES,
  NO_CARD_DATA_MESSAGE,
  assetLooksLike,
  buildCharacterFormState,
  buildCharacterPatch,
  characterFormSignature,
  characterWithFormState,
  formatImportSize,
  getPickedAsset,
  hasCardContent,
  isLargeImport,
  isPngBuffer,
  worldEntryMeta,
} from './character/cardHelpers.js';

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
  const styles = useMemo(() => createCharacterStyles(theme, fonts, tokens), [theme, fonts, tokens]);
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
  const [characterPresets, setCharacterPresets] = useState([]);
  const [voiceDisplay, setVoiceDisplay] = useState('text');
  const [characterListExpanded, setCharacterListExpanded] = useState(false);
  const [characterScrubberOpen, setCharacterScrubberOpen] = useState(false);
  const [expandedWorld, setExpandedWorld] = useState(false);
  const [expandedRegex, setExpandedRegex] = useState(false);
  const [editingWorldId, setEditingWorldId] = useState(null);
  const [editingRegexId, setEditingRegexId] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [bgPreview, setBgPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [characterPresetPanelOpen, setCharacterPresetPanelOpen] = useState(false);
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
  const [formReady, setFormReady] = useState(false);
  const [switchAuthorization, setSwitchAuthorization] = useState(0);
  const [topic, setTopic] = useState(null);
  const seededIdRef = useRef(null);
  const seededFormSignatureRef = useRef('');
  const seededCharacterSignatureRef = useRef('');
  const externalConflictRef = useRef(false);
  const formDirtyRef = useRef(false);
  const formSignatureRef = useRef('');
  const draftTimerRef = useRef(null);
  // Tab 拦截信箱需要调用「最新的」save。save 在下方才声明，若直接把 save 放进
  // guard effect 的依赖数组，本轮渲染求值该数组时 save 尚未赋值（Babel 把
  // const 降级为 var，此处读到 undefined），undefined===undefined 让 effect
  // 永不重跑，guard 会一直持有首次 dirty 那一刻的旧闭包——按「保存并离开」
  // 只落库了旧表单，界面表单仍与已保存内容不同，于是切回再切走又弹窗。
  // 用 ref 持有最新引用，effect 只依赖 dirty 闸门，始终调用最新 save。
  const saveRef = useRef(null);
  const saveInFlightRef = useRef(false);
  const formOwnerIdRef = useRef(activeId);
  const formSessionIdRef = useRef(activeSessionId);
  const revertingToRef = useRef('');
  const authorizedActiveIdRef = useRef('');
  const characterScrollRef = useRef(null);
  const characterLibraryLayoutRef = useRef({ top: 0 });
  const characterGridRelativeLayoutRef = useRef({ top: 0, height: 0 });
  const characterGridLayoutRef = useRef({ top: 0, height: 0 });
  const characterCardRelativeOffsetsRef = useRef({});
  const characterViewportHeightRef = useRef(0);
  const characterCardOffsetsRef = useRef({});
  const switchLockRef = useRef(false);
  const pendingImageUrisRef = useRef(new Map());
  const imageOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const { height: windowHeight } = useWindowDimensions();
  const screenSessionRef = useRef({ activeId });
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const currentFormState = useMemo(() => ({
    name,
    tags,
    systemPrompt,
    description,
    personality,
    scenario,
    firstMes,
    alternateGreetings,
    mesExample,
    worldInfo,
    regexScripts,
    presets: characterPresets,
    avatarUri: avatarPreview || '',
    bgUri: bgPreview || '',
    voiceDisplay,
  }), [
    name,
    tags,
    systemPrompt,
    description,
    personality,
    scenario,
    firstMes,
    alternateGreetings,
    mesExample,
    worldInfo,
    regexScripts,
    characterPresets,
    avatarPreview,
    bgPreview,
    voiceDisplay,
  ]);
  const currentFormSignature = useMemo(
    () => JSON.stringify(currentFormState),
    [currentFormState]
  );
  const savedFormSignature = useMemo(
    () => characterFormSignature(character),
    [character]
  );
  // 脏判定对齐「表单 vs 本角色 seed 时的表单快照」，而不是「表单 vs 角色当前内容」：
  // 角色内容会被记忆摘要写入世界书、其他页面保存等后台更新，拿后者当参照会让
  // 没动过表单的用户被误判为有未保存修改（切换角色与切 Tab 都会误弹窗）。
  // 外部更新由 seed effect 的 externalConflict 机制处理；formReady 闸门避免 seed 期间误报。
  //
  // 额外兜底「表单内容与当前已保存角色完全一致 → 必然没有未保存修改」：保存后存储层
  // 可能对字段做规范化（id 去重、presets 补默认名等），使回读的角色内容与 save() 当时
  // 推进的 seed 基准逐字不同；只比 seed 会让用户「明明保存了还弹未保存」。
  const formDirty = isFormDirty({
    formReady,
    currentSignature: currentFormSignature,
    seededSignature: seededFormSignatureRef.current,
    savedSignature: savedFormSignature,
  });
  formDirtyRef.current = formDirty;
  formSignatureRef.current = currentFormSignature;
  const editedCharacter = useMemo(
    () => characterWithFormState(character, currentFormState),
    [character, currentFormState]
  );
  if (screenSessionRef.current.activeId !== activeId) {
    screenSessionRef.current = { activeId };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      imageOperationRef.current += 1;
      screenSessionRef.current = {};
      pendingImageUrisRef.current.forEach(uri => {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      });
      pendingImageUrisRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (formDirtyRef.current) return;
    imageOperationRef.current += 1;
    pendingImageUrisRef.current.forEach(uri => {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    });
    pendingImageUrisRef.current.clear();
  }, [activeId]);

  // Tab 切换拦截信箱：角色页未保存时，AppShell 的 tabPress 监听弹确认框。
  // save 每次渲染都是新引用，这里靠 effect 在提交后同步；cleanup 保证
  // 卸载或表单态变化时信箱立即回落到安全默认值。
  useEffect(() => {
    setCharacterEditGuard({
      dirty: formReady && formDirty,
      save: options => (saveRef.current ? saveRef.current(options) : Promise.resolve(false)),
    });
    return () => setCharacterEditGuard(null);
  }, [formReady, formDirty]);

  // 编辑草稿防抖暂存：切走或杀 App 后回来可恢复未保存的修改。
  // 表单与角色一致（含保存后 seed 回一致）时清草稿，避免下次误弹恢复框。
  useEffect(() => {
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    if (!loaded || !formReady) return undefined;
    const characterId = String(character.id || '');
    if (!characterId) return undefined;
    if (!formDirty) {
      clearCharacterEditDraft(characterId).catch(() => {});
      return undefined;
    }
    const formState = currentFormState;
    draftTimerRef.current = setTimeout(() => {
      saveCharacterEditDraft(characterId, formState, savedFormSignature).catch(() => {});
    }, 800);
    return () => {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    };
  }, [loaded, formReady, formDirty, currentFormState, character, savedFormSignature]);

  useEffect(() => {
    if (!loaded) return;
    const characterSignature = characterFormSignature(character);
    const sameCharacter = seededIdRef.current === activeId;
    const externalChanged = seededCharacterSignatureRef.current !== characterSignature;
    const authorized = authorizedActiveIdRef.current === activeId;
    if (
      seededIdRef.current
      && !sameCharacter
      && formDirtyRef.current
      && !authorized
      && !revertingToRef.current
    ) {
      const previousId = seededIdRef.current;
      const previousSessionId = formSessionIdRef.current;
      const revert = () => {
        if (!previousId || previousId === activeId) return;
        revertingToRef.current = previousId;
        switchCharacter(previousId)
          .then(() => (previousSessionId ? switchSession(previousSessionId) : null))
          .catch(() => {
            if (mountedRef.current) Alert.alert('角色切换失败', '未能恢复原来的会话，请重新打开应用。');
          })
          .finally(() => {
            if (revertingToRef.current === previousId) revertingToRef.current = '';
          });
      };
      Alert.alert('有未保存的编辑', '角色发生切换，请选择取消并保留编辑，或放弃修改后继续。', [
        { text: '取消', style: 'cancel', onPress: revert },
        {
          text: '放弃并切换',
          style: 'destructive',
          onPress: () => {
            authorizedActiveIdRef.current = activeId;
            setSwitchAuthorization(value => value + 1);
          },
        },
      ]);
      return;
    }
    if (authorized) authorizedActiveIdRef.current = '';
    if (sameCharacter && !externalChanged) return;
    if (sameCharacter && currentFormSignature !== seededFormSignatureRef.current) {
      seededCharacterSignatureRef.current = characterSignature;
      externalConflictRef.current = true;
      return;
    }
    const next = buildCharacterFormState(character);
    setFormReady(false);
    seededIdRef.current = activeId;
    formOwnerIdRef.current = activeId;
    formSessionIdRef.current = activeSessionId;
    seededFormSignatureRef.current = JSON.stringify(next);
    seededCharacterSignatureRef.current = characterSignature;
    externalConflictRef.current = false;
    applyDraftFormState(next);
    setEditingWorldId(null);
    setEditingRegexId(null);
    setFormReady(true);
    // seed 完成后检测编辑草稿：切走/杀 App 留下的未保存编辑在这里问一次。
    // takeCharacterEditDraft 读即取走，同一份草稿不会重复弹框。
    const draftOwnerId = activeId;
    takeCharacterEditDraft(draftOwnerId).then(draft => {
      if (!draft || !mountedRef.current) return;
      // seed 可能已经再次变化（角色又切换/外部更新）：草稿只恢复到仍属于它的表单。
      if (formOwnerIdRef.current !== draftOwnerId || seededIdRef.current !== draftOwnerId) return;
      Alert.alert(
        '检测到未保存的编辑',
        '上次编辑的内容尚未保存，恢复后可以继续修改。',
        [
          { text: '丢弃', style: 'destructive' },
          {
            text: '恢复',
            // 用 buildCharacterFormState 规范化：旧版本草稿可能缺字段，
            // 直接入表单会把 undefined 塞进 TextInput。
            onPress: () => applyDraftFormState(buildCharacterFormState(draft.formState)),
          },
        ]
      );
    }).catch(() => {});
  }, [loaded, activeId, character, currentFormSignature, switchAuthorization, switchCharacter, applyDraftFormState]);

  // 会话切换时同步「表单所属会话」ref：seed effect 只在角色变化时跑，同一角色内
  // 切换会话不会更新它。否则「有未保存编辑→切角色→取消回滚」会跳回旧会话。
  useEffect(() => {
    formSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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

  // 返回布尔：true = 已落库（UI 同步可跳过不算失败）；false = 未保存。
  // 供 Tab 切换拦截的「保存并离开」判断是否切换。
  const saveInternal = async (options = {}) => {
    if (!loaded) {
      Alert.alert('角色加载中', '请稍候再保存。');
      return false;
    }
    if (!seededFormSignatureRef.current) {
      Alert.alert('角色加载中', '请稍候再保存。');
      return false;
    }
    if (formOwnerIdRef.current !== String(character.id || '')) {
      Alert.alert('角色已切换', '请先处理角色切换，再保存当前编辑。');
      return false;
    }
    if (externalConflictRef.current && options.force !== true) {
      Alert.alert(
        '角色已在其他页面更新',
        '继续保存会覆盖其他页面中的修改。',
        [
          { text: '取消', style: 'cancel' },
          { text: '覆盖保存', style: 'destructive', onPress: () => save({ force: true }) },
        ]
      );
      return false;
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
        return false;
      }
    }
     const session = screenSessionRef.current;
     const previousAvatar = character.avatarUri || '';
     const previousBg = character.bgUri || '';
     const trimmedPrompt = systemPrompt.trim();
     const next = {

      id: character.id,
    name: name.trim() || 'EasyChat2 助手',
    // 「人设/系统提示」允许并保持空白：默认值仅在 chatPipeline 发送时兜底，
    // 用户主动留空的人设不能被覆写成默认卡文案。
    systemPrompt: trimmedPrompt,
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
      presets: characterPresets,
      voiceDisplay: ['text', 'voice-text', 'voice'].includes(voiceDisplay) ? voiceDisplay : 'text',
       avatarUri: avatarPreview || '',
       bgUri: bgPreview || '',
     };
     const saveFormSignature = currentFormSignature;
     const expectedCharacterSignature = characterFormSignature(character);
     try {
       const savePatch = current => {
         if (characterFormSignature(current) !== expectedCharacterSignature) {
           const conflict = new Error('角色已被其他页面更新');
           conflict.code = 'CHARACTER_CONFLICT';
           throw conflict;
         }
         return next;
       };
        savePatch.id = character.id;
        await updateCharacter(savePatch);
        // 已落库：编辑草稿不再需要，清掉避免下次回来误弹恢复框。
        clearCharacterEditDraft(character.id).catch(() => {});
        if (screenSessionRef.current !== session) return true;
        const persistedFormState = buildCharacterFormState(next);
        const persistedFormSignature = JSON.stringify(persistedFormState);
        seededFormSignatureRef.current = persistedFormSignature;
        seededCharacterSignatureRef.current = persistedFormSignature;
        formOwnerIdRef.current = next.id;
        formSessionIdRef.current = activeSessionId;
        externalConflictRef.current = false;
        if (formSignatureRef.current !== saveFormSignature) return true;
       const nextImageRefs = new Set([next.avatarUri, next.bgUri].filter(Boolean));
       if (pendingImageUrisRef.current.get('avatar') === next.avatarUri) {
         pendingImageUrisRef.current.delete('avatar');
       }
       if (pendingImageUrisRef.current.get('bg') === next.bgUri) {
         pendingImageUrisRef.current.delete('bg');
       }
         const momentsStatus = await getMomentsStatus().catch(() => ({ status: 'corrupt', moments: [] }));
         if (screenSessionRef.current !== session || formSignatureRef.current !== saveFormSignature) return true;
        const referencedElsewhere = uri => (
          charactersRef.current.some(item => item.id !== character.id && (
            item.avatarUri === uri || item.bgUri === uri
          ))
          || sessionsRef.current.some(item => item && (item.avatarUri === uri || item.bgUri === uri))
          || (momentsStatus.status === 'ok'
            && momentsStatus.moments.some(item => item && item.avatarUri === uri))
        );
        if (momentsStatus.status === 'ok') {
          [previousAvatar, previousBg].forEach(uri => {
            if (!uri || nextImageRefs.has(uri) || isRecentMediaUri(uri) || referencedElsewhere(uri)) return;
            FileSystem.deleteAsync(uri, { idempotent: true }).catch(error => {
              if (__DEV__) console.warn('[character] old image cleanup failed', error);
            });
          });
        }
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
       setCharacterPresets(next.presets);
       setVoiceDisplay(next.voiceDisplay || 'text');
       const savedFormState = buildCharacterFormState(next);
       const savedFormSignatureValue = JSON.stringify(savedFormState);
       seededIdRef.current = next.id;
       formOwnerIdRef.current = next.id;
       seededFormSignatureRef.current = savedFormSignatureValue;
       seededCharacterSignatureRef.current = savedFormSignatureValue;
       externalConflictRef.current = false;
       Alert.alert('已保存', '角色设定已同步，聊天页会立即生效。');
       return true;
     } catch (error) {
       Alert.alert(
         error && error.code === 'CHARACTER_CONFLICT' ? '角色已更新' : '保存失败',
         error && error.code === 'CHARACTER_CONFLICT'
           ? '其他页面已修改该角色，请重新加载后再保存。'
           : '请检查存储空间或权限。'
       );
       return false;
     }
   };
  // 保存闸门：保存进行中再次点击（连点/保存后未重渲染再次触发）会以旧角色签名
  // 发起第二次 updateCharacter，必然抛 CHARACTER_CONFLICT，弹出误导性的「其他页面已修改」。
  // 直接忽略并发保存；强制覆盖走 Alert 回调（此时上一次已结束）。
  const save = async (options = {}) => {
    if (saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    try {
      return await saveInternal(options);
    } finally {
      saveInFlightRef.current = false;
    }
  };
  saveRef.current = save;

  const importCard = async () => {
    if (importing || !loaded) return;
    setImporting(true);
    setImportStatus({ phase: 'reading', large: false, size: 0 });

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
      let assetSize = Number(asset.size) > 0 ? Number(asset.size) : 0;
      if (assetSize <= 0) {
        const info = await FileSystem.getInfoAsync(asset.uri).catch(() => null);
        assetSize = Number(info && info.size) > 0 ? Number(info.size) : 0;
      }
      if (assetSize > MAX_IMPORT_BYTES) {
        Alert.alert('角色卡文件过大', `请选择不超过 ${formatImportSize(MAX_IMPORT_BYTES)} 的文件。`);
        return;
      }
      setImportStatus({
        phase: 'reading',
        large: isLargeImport(assetSize),
        size: assetSize,
      });

      let buffer;
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        buffer = Buffer.from(base64, 'base64');
        if (buffer.length > MAX_IMPORT_BYTES) {
          Alert.alert('角色卡文件过大', `请选择不超过 ${formatImportSize(MAX_IMPORT_BYTES)} 的文件。`);
          return;
        }
        const importSize = assetSize || buffer.length;
        setImportStatus({
          phase: 'reading',
          large: isLargeImport(importSize),
          size: importSize,
        });
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

      const patch = buildCharacterPatch(parsed);
      // 先让用户选择 / 修改 / 新增开场白，再真正落库
      setPendingImport({
        patch,
        treatAsPng,
        assetUri: (asset && asset.uri) || '',
        large: isLargeImport(assetSize || buffer.length),
        size: assetSize || buffer.length,
        candidates: listGreetingCandidates(parsed.fields || {}),
      });
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  };

  const confirmImport = async result => {
    const pending = pendingImport;
    if (!pending) return;
    const next = {
      ...pending.patch,
      firstMes: result.firstMes,
      alternateGreetings: result.alternateGreetings,
    };
    setImporting(true);
     setImportStatus({
       phase: 'saving',
       large: !!pending.large,
       size: Number(pending.size) || 0,
     });
     let importedImageUri = '';
     try {

      const created = await addCharacter(next);
      setPendingImport(null);
      const profile = await getUserProfile().catch(() => ({}));
      const openingTemplate = String(result.firstMes || '');
      const openingText = openingTemplate.replace(/\{\{user\}\}/g, () => String(profile.userName || '用户'));
      await ensureCharacterSession(created.id, {
        text: openingText,
        template: openingTemplate,
      }).catch(() => {});

     const session = screenSessionRef.current;
     let imageFailed = false;
     if (pending.treatAsPng && pending.assetUri) {

        try {
          const avatarDir = `${FileSystem.documentDirectory}avatars/`;
          await FileSystem.makeDirectoryAsync(avatarDir, { intermediates: true });
           const dest = `${avatarDir}${created.id}.png`;
           markMediaWrite(dest);
           await FileSystem.copyAsync({ from: pending.assetUri, to: dest });
           importedImageUri = dest;
           await updateCharacter({ id: created.id, avatarUri: dest, bgUri: dest });

          if (screenSessionRef.current === session && session.activeId === created.id) {
            setAvatarPreview(dest);
            setBgPreview(dest);
          }
        } catch (error) {
          if (importedImageUri) {
            FileSystem.deleteAsync(importedImageUri, { idempotent: true }).catch(() => {});
            importedImageUri = '';
          }
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
        `预设 ${next.presets.length} 条`,
        next.firstMes ? '含开场白' : '无开场白',
      ].join('，');
       Alert.alert(
         imageFailed ? '角色已导入，图片保存失败' : '导入成功',
         imageFailed ? `${summary}。请在该角色页面重新选择头像和背景图。` : summary
       );
     } catch (error) {
       if (importedImageUri) {
         FileSystem.deleteAsync(importedImageUri, { idempotent: true }).catch(() => {});
       }
       const detail = maskSecrets(error?.message || String(error));

      const message = /角色库仍在恢复中/.test(detail)
        ? `${detail}\n你编辑的开场白仍会保留。`
        : /full|disk|空间|容量/i.test(detail)
          ? '存储空间不足，请释放空间后重试。你编辑的开场白仍会保留。'
          : '请检查存储空间或权限后重试。你编辑的开场白仍会保留。';
      Alert.alert('导入失败', message);
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  };

  // 反向导入：把当前角色读进制卡草稿，跳到「扩展 → 制卡」用 AI 继续改
  const onImportToForge = () => {
    if (!editedCharacter) return;
    const apply = () => {
      const fresh = createForgeState();
      saveCardForge({
        ...fresh,
        draft: draftFromCharacter(editedCharacter),
        // 保留首题，方便载入后继续点选项；引导语换成"从角色载入"的说明
        transcript: [
          {
            id: `forge-${Date.now()}-from-character`,
            role: 'note',
            text: `已载入角色「${editedCharacter.name || '未命名'}」的设定。直接说修改要求（例如「把性格改得更冷淡」），或继续回答下面的问题。`,
            createdAt: Date.now(),
          },
          ...fresh.transcript.slice(1),
        ],
        updatedAt: Date.now(),
      })
        .then(() => navigation.navigate('扩展', { segment: 'forge', ts: Date.now() }))
        .catch(() => Alert.alert('载入失败', '请检查存储空间或权限。'));
    };
    Alert.alert(
      '导入到制卡',
      formDirty
        ? '会把当前界面中的角色设定载入制卡草稿，包含尚未保存的编辑。原角色不受影响。'
        : '会把当前角色的设定载入制卡草稿，原角色不受影响。继续吗？',
      [
        { text: '取消', style: 'cancel' },
        { text: '继续', onPress: apply },
      ]
    );
  };

  const readAvatarBytes = async uri => {
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
      const avatarBytes = format === 'png' ? await readAvatarBytes(editedCharacter.avatarUri) : null;
      const uri = await exportCardFile(editedCharacter, format, avatarBytes);
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
      Alert.alert('导出失败', maskSecrets((error && error.message) || '请稍后重试。'));
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  const onExport = () => {
    if (exportBusyRef.current || !loaded) return;
    Alert.alert(
      '导出角色卡',
      formDirty
        ? '将导出当前界面中的内容，包含尚未保存的编辑。请选择格式。'
        : '请选择导出格式。',
      [
        { text: '取消', style: 'cancel' },
        { text: 'PNG 图片', onPress: () => runExport('png') },
        { text: 'JSON 文件', onPress: () => runExport('json') },
      ]
    );
  };

  const toggleGroupMember = id => {
    if (!groupSelected.includes(id) && groupSelected.length >= 8) {
      Alert.alert('成员数量已达上限', '群聊最多选择 8 个角色。');
      return;
    }
    setGroupSelected(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
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
       try {
         await refreshSessions();
       } catch (error) {
         Alert.alert('群聊已创建', '会话列表刷新失败，请重新进入应用后查看。');
         return;
       }
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

  const onSwitch = async id => {
    if (switchLockRef.current) return;
    const performSwitch = async () => {
      if (switchLockRef.current) return;
      switchLockRef.current = true;
      const previousCharacterId = activeId;
      const previousSessionId = activeSessionId;
      try {
        await switchCharacter(id);
        await ensureCharacterSession(id);
      } catch (error) {
        let rollbackFailed = false;
        try {
          authorizedActiveIdRef.current = previousCharacterId;
          setSwitchAuthorization(value => value + 1);
          await switchCharacter(previousCharacterId);
          if (previousSessionId) await switchSession(previousSessionId);
        } catch (rollbackError) {
          rollbackFailed = true;
        }
        Alert.alert(
          '切换失败',
          rollbackFailed
            ? '切换失败且未能恢复原状态，请重新打开应用后重试。'
            : '请检查存储空间或权限。'
        );
      } finally {
        switchLockRef.current = false;
      }
    };
    if (id !== activeId && formDirtyRef.current) {
      Alert.alert('有未保存的编辑', '切换角色会放弃当前界面中的修改。', [
        { text: '取消', style: 'cancel' },
        {
          text: '放弃并切换',
          style: 'destructive',
          onPress: () => {
            // 用户明确放弃：清掉编辑草稿，切回来时不再弹「恢复编辑」。
            clearCharacterEditDraft(activeId).catch(() => {});
            authorizedActiveIdRef.current = id;
            setSwitchAuthorization(value => value + 1);
            performSwitch();
          },
        },
      ]);
      return;
    }
    await performSwitch();
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

  const characterDisplayItems = useMemo(() => [
    ...visibleCharacters.map(item => ({
      id: item.id,
      kind: 'character',
      item,
    })),
    ...(editMode ? [] : visibleGroups.map(group => ({
      id: `group-${group.id}`,
      kind: 'group',
      item: group,
    }))),
  ], [editMode, visibleCharacters, visibleGroups]);
  const characterListNeedsCollapse = characterDisplayItems.length > CHARACTER_LIST_COLLAPSE_LIMIT;
  const displayedCharacterItems = characterListExpanded
    ? characterDisplayItems
    : characterDisplayItems.slice(0, CHARACTER_LIST_COLLAPSE_LIMIT);
  const displayedCharacters = displayedCharacterItems.filter(item => item.kind === 'character').map(item => item.item);
  const displayedGroups = displayedCharacterItems.filter(item => item.kind === 'group').map(item => item.item);
  const characterScrubberPreviews = useMemo(() => displayedCharacterItems.map(item => ({
    label: item.kind === 'group' ? '群聊' : '角色',
    speaker: item.kind === 'group' ? groupNameOf(item.item) : (item.item.name || '未命名角色'),
    text: item.kind === 'group'
      ? `${(item.item.members || []).length} 人群聊`
      : (item.item.tags || []).map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 3).join('、') || '角色卡',
  })), [displayedCharacterItems, groupNameOf]);

  useEffect(() => {
    if (!characterListNeedsCollapse && characterListExpanded) {
      setCharacterListExpanded(false);
      setCharacterScrubberOpen(false);
    }
  }, [characterListNeedsCollapse, characterListExpanded]);

  useEffect(() => {
    if (editMode) setCharacterScrubberOpen(false);
  }, [editMode]);

  // 不要在列表变化时清空卡片偏移缓存再指望 onLayout 回填：布局未变的卡片
  // 不触发 onLayout（如展开列表时折叠态就存在的前 10 张卡），会导致定位滑块
  // 指向它们时 offset 缺失、静默不滚动。位置变化的卡片由 onLayout 自然覆盖，
  // grid 位移由 updateCharacterCardOffsets 用 relative 缓存重建，已删除条目
  // 的残留偏移不会被查询——保留旧值是安全的。

  // seed 与草稿恢复共用的表单写入序列：把一份 formState 应用到表单 state。
  const applyDraftFormState = useCallback(next => {
    setName(next.name);
    setSystemPrompt(next.systemPrompt);
    setDescription(next.description);
    setPersonality(next.personality);
    setTags(next.tags);
    setScenario(next.scenario);
    setFirstMes(next.firstMes);
    setAlternateGreetings(next.alternateGreetings);
    setMesExample(next.mesExample);
    setWorldInfo(next.worldInfo);
    setRegexScripts(next.regexScripts);
    setCharacterPresets(next.presets);
    setVoiceDisplay(next.voiceDisplay || 'text');
    setAvatarPreview(next.avatarUri || null);
    setBgPreview(next.bgUri || null);
  }, []);

  const scrollCharacterTo = useCallback(y => {
    characterScrollRef.current?.scrollTo?.({ y: Math.max(0, y), animated: true });
  }, []);

  const updateCharacterCardOffsets = useCallback(() => {
    const gridTop = characterGridLayoutRef.current.top;
    Object.entries(characterCardRelativeOffsetsRef.current).forEach(([id, offset]) => {
      characterCardOffsetsRef.current[id] = gridTop + offset;
    });
  }, []);

  const onCharacterLibraryLayout = useCallback(event => {
    characterLibraryLayoutRef.current = { top: Number(event.nativeEvent.layout.y) || 0 };
    characterGridLayoutRef.current = {
      top: characterLibraryLayoutRef.current.top + characterGridRelativeLayoutRef.current.top,
      height: characterGridRelativeLayoutRef.current.height,
    };
    updateCharacterCardOffsets();
  }, [updateCharacterCardOffsets]);

  const onCharacterGridLayout = useCallback(event => {
    const { y, height } = event.nativeEvent.layout;
    characterGridRelativeLayoutRef.current = { top: Number(y) || 0, height: Number(height) || 0 };
    characterGridLayoutRef.current = {
      top: characterLibraryLayoutRef.current.top + characterGridRelativeLayoutRef.current.top,
      height: characterGridRelativeLayoutRef.current.height,
    };
    updateCharacterCardOffsets();
  }, [updateCharacterCardOffsets]);

  const onCharacterItemLayout = useCallback((id, event) => {
    const offset = Number(event.nativeEvent.layout.y || 0);
    characterCardRelativeOffsetsRef.current[id] = offset;
    characterCardOffsetsRef.current[id] = characterGridLayoutRef.current.top + offset;
  }, []);

  const onCharacterScrubberSeek = useCallback(index => {
    const target = displayedCharacterItems[index];
    if (!target) return;
    const offset = characterCardOffsetsRef.current[target.id];
    if (typeof offset === 'number') scrollCharacterTo(offset - 8);
  }, [displayedCharacterItems, scrollCharacterTo]);

  const onCharacterScrubberToStart = useCallback(() => {
    const { top } = characterGridLayoutRef.current;
    const viewport = characterViewportHeightRef.current || windowHeight;
    scrollCharacterTo(getScrollRange({ top, height: 0, viewport }).start);
  }, [scrollCharacterTo, windowHeight]);

  const onCharacterScrubberToEnd = useCallback(() => {
    const { top, height } = characterGridLayoutRef.current;
    const viewport = characterViewportHeightRef.current || windowHeight;
    scrollCharacterTo(getScrollRange({ top, height, viewport }).end);
  }, [scrollCharacterTo, windowHeight]);

  const toggleCharacterList = useCallback(() => {
    const next = !characterListExpanded;
    setCharacterListExpanded(next);
    if (next) {
      requestAnimationFrame(() => setCharacterScrubberOpen(characterListNeedsCollapse));
    } else {
      setCharacterScrubberOpen(false);
    }
  }, [characterListExpanded, characterListNeedsCollapse]);

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

  const visibleSelectableIds = useMemo(
    () => visibleCharacters.filter(item => item.id !== 'default').map(item => item.id),
    [visibleCharacters]
  );
  const allVisibleSelected = visibleSelectableIds.length > 0
    && visibleSelectableIds.every(id => selectedIds.includes(id));

  useEffect(() => {
    setSelectedIds(current => current.filter(id => visibleSelectableIds.includes(id)));
  }, [visibleSelectableIds]);

  const selectAll = () => {
    setSelectedIds(allVisibleSelected ? [] : visibleSelectableIds);
  };

  const onTogglePin = item => {
    pinCharacter(item.id, !item.pinned).catch(() => {
      Alert.alert('置顶失败', '请检查存储空间或权限。');
    });
  };

  const sessionsOfCharacters = useCallback(ids => (
    selectSessionsForCharacters(sessions, ids)
      .map(session => session.id)
      .filter(Boolean)
  ), [sessions]);

  const countLinkedMoments = useCallback(async (characterIds, sessionIds) => {
    const { status, moments } = await getMomentsStatus();
    if (status === 'corrupt') {
      throw new Error('动态记录读取失败，请稍后重试');
    }
    return countMomentsForCharacterDeletion(moments, characterIds, sessionIds);
  }, []);

  const removeMomentsOfCharacterData = useCallback((characterIds, sessionIds) => (
    deleteMomentsForCharacterDeletion(characterIds, sessionIds)
  ), []);

  const runDeleteSelected = (ids, deleteMemories) => {
    const targetIds = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    if (targetIds.length === 0) return;
    const memoryIds = sessionsOfCharacters(targetIds);
    let momentsDeleted = false;
    let sessionsDeleted = false;
    const beforeCharacterDelete = async () => {
      if (!deleteMemories) return;
      await removeMomentsOfCharacterData(targetIds, memoryIds);
      momentsDeleted = true;
      if (memoryIds.length > 0) {
        await deleteSessions(memoryIds, targetIds);
      }
      sessionsDeleted = true;
    };
    Promise.resolve()
      .then(beforeCharacterDelete)
      .then(() => (
        targetIds.length === 1
          ? deleteCharacter(targetIds[0], { clearVectorIds: deleteMemories ? targetIds : [] })
          : deleteCharacters(targetIds, { clearVectorIds: deleteMemories ? targetIds : [] })
      ))
      .then(() => {
        setSelectedIds([]);
        setEditMode(false);
      })
      .catch(error => {
        let message = (error && error.message) || '请检查存储空间或权限。';
        if (deleteMemories && momentsDeleted && sessionsDeleted) {
          message = '关联动态和记忆已删除，但角色删除失败，请重试。';
        } else if (deleteMemories && momentsDeleted) {
          message = '关联动态已删除，但记忆删除失败，角色未删除，请重试。';
        } else if (deleteMemories) {
          message = '关联动态删除失败，角色未删除，请重试。';
        }
        Alert.alert('删除失败', message);
      });
  };

  const showDeleteChoice = (ids, intro) => {
    const targetIds = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    if (targetIds.length === 0) return;
    const memoryIds = sessionsOfCharacters(targetIds);
    countLinkedMoments(targetIds, memoryIds)
      .then(linked => {
        const details = [];
        if (memoryIds.length > 0) details.push(`${memoryIds.length} 条记忆`);
        if (linked > 0) details.push(`${linked} 条动态`);
        if (details.length === 0) {
          Alert.alert('删除角色', intro, [
            { text: '取消', style: 'cancel' },
            {
              text: '删除',
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, false),
            },
          ]);
          return;
        }
        Alert.alert(
          '删除角色',
          `${intro}\n关联数据：${details.join('、')}。是否一并删除？`,
          [
            { text: '取消', style: 'cancel' },
            { text: '仅删角色', onPress: () => runDeleteSelected(targetIds, false) },
            {
              text: '角色、记忆和动态都删',
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, true),
            },
          ]
        );
      })
      .catch(() => {
        Alert.alert('删除失败', '没能读出关联数据，请稍后重试。');
      });
  };

  const confirmSelectedDelete = ids => {
    showDeleteChoice(ids, `将删除选中的 ${ids.length} 个角色。`);
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

  const onDeleteCharacter = item => {
    showDeleteChoice(
      [item.id],
      `确定删除「${item.name || '未命名角色'}」吗？`
    );
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
      const created = await addCharacter({ name: '新角色' });
      // 同上：新角色要有自己的会话，聊天页才不会留着上一个角色的对话
      await ensureCharacterSession(created.id).catch(() => {});
    } catch (error) {
      Alert.alert('新建失败', '请检查存储空间或权限。');
    }
  };

  const pickImage = async (setter, fieldName) => {
    if (!loaded || !mountedRef.current) return;
    const operation = ++imageOperationRef.current;
    const session = screenSessionRef.current;
    const isCurrent = () => (
      mountedRef.current
      && imageOperationRef.current === operation
      && screenSessionRef.current === session
    );
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = getPickedAsset(result);
      if (!asset?.uri || !isCurrent()) return;
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      if (!isCurrent()) return;
      const mime = String(asset.mimeType || '').toLowerCase();
      const ext = mime === 'image/png' || /\.png(?:$|\?)/i.test(asset.uri) ? '.png' : '.jpg';
       const dest = `${dir}${character.id}-${fieldName}-${Date.now()}${ext}`;
       markMediaWrite(dest);
       await FileSystem.copyAsync({ from: asset.uri, to: dest });
      if (!isCurrent()) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
        return;
      }
      const previousPending = pendingImageUrisRef.current.get(fieldName);
      if (previousPending && previousPending !== dest) {
        await FileSystem.deleteAsync(previousPending, { idempotent: true }).catch(() => {});
      }
      pendingImageUrisRef.current.set(fieldName, dest);
      setter(dest);
    } catch (error) {
      if (isCurrent()) Alert.alert('图片读取失败', '请重试。');
    }
  };

  const pickAvatar = () => pickImage(setAvatarPreview, 'avatar');
  const pickBg = () => pickImage(setBgPreview, 'bg');
  const clearImagePreview = (fieldName, setter) => {
    const pending = pendingImageUrisRef.current.get(fieldName);
    if (pending) {
      FileSystem.deleteAsync(pending, { idempotent: true }).catch(() => {});
      pendingImageUrisRef.current.delete(fieldName);
    }
    setter(null);
  };

  const editingWorldIndex = worldInfo.findIndex(item => item.id === editingWorldId);
  const editingWorldEntry = editingWorldIndex >= 0 ? worldInfo[editingWorldIndex] : null;
  const editingRegexIndex = regexScripts.findIndex(item => item.id === editingRegexId);
  const editingRegexEntry = editingRegexIndex >= 0 ? regexScripts[editingRegexIndex] : null;

  const card = character || {};
  const importSizeLabel = formatImportSize(importStatus && importStatus.size);
  const importStatusTitle = !importStatus
    ? ''
    : importStatus.large
      ? importStatus.phase === 'saving' ? '大卡片正在保存' : '大卡片正在读取'
      : importStatus.phase === 'saving' ? '正在保存角色卡' : '正在导入角色卡';
  const importStatusHint = !importStatus
    ? ''
    : importStatus.large
      ? `${importStatus.phase === 'saving' ? '正在写入本地存储' : '正在读取并解析文件'}${importSizeLabel ? ` · ${importSizeLabel}` : ''}，请稍候`
      : importStatus.phase === 'saving' ? '正在写入本地存储，请稍候' : '正在读取并解析文件，请稍候';

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={characterScrollRef}
        style={styles.container}
        pointerEvents={formReady ? 'auto' : 'none'}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        onLayout={event => {
          characterViewportHeightRef.current = Number(event.nativeEvent.layout.height) || windowHeight;
        }}
      >
        <View style={styles.pageHeader}>
          <Text style={styles.title}>角色</Text>
          <FieldHint style={styles.hint}>聊天时会把这里的设定作为系统提示词发送给模型。</FieldHint>
          {isValidAigcMeta(character && character.aigcMeta) ? (
            <Text style={styles.aigcBadge}>{`本卡由 AI 生成 · 内容编号 ${character.aigcMeta.contentCode || ''}`}</Text>
          ) : null}
        </View>

        <Card onLayout={onCharacterLibraryLayout}>
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
                 <TouchableOpacity style={styles.selectBarAction} onPress={selectAll} activeOpacity={0.8}>

                 <Text style={styles.selectBarText}>{allVisibleSelected ? '取消全选' : '全选'}</Text>

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
          {characterListNeedsCollapse ? (
            <View style={styles.characterListControls}>
              <TouchableOpacity
                style={styles.characterListToggle}
                onPress={toggleCharacterList}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Ionicons
                  name={characterListExpanded ? 'chevron-up' : 'chevron-down'}
                  size={15}
                  color={theme.colors.primarySoft}
                />
                <Text style={styles.characterListToggleText}>
                  {characterListExpanded
                    ? '折叠角色列表'
                    : `展开全部角色（${characterDisplayItems.length}）`}
                </Text>
              </TouchableOpacity>
              {characterListExpanded ? (
                <TouchableOpacity
                  style={styles.characterListLocate}
                  onPress={() => setCharacterScrubberOpen(true)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="打开角色列表定位"
                >
                  <Ionicons name="options-outline" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.characterListLocateText}>定位</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
          {characterDisplayItems.length === 0 ? (
            <Text style={styles.emptyHint}>没有匹配的角色，换个关键词试试。</Text>
          ) : null}
          <View style={styles.characterGrid} onLayout={onCharacterGridLayout}>
            {displayedCharacters.map(item => {
              const selected = !activeIsGroup && item.id === activeId;
              const checked = selectedIds.includes(item.id);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.characterCard, selected && styles.characterCardActive]}
                  onLayout={event => onCharacterItemLayout(item.id, event)}
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
                      {item.tags.slice(0, 3).map((tag, index) => (
                        <Text key={`${tag}-${index}`} style={styles.characterCardTag} numberOfLines={1}>{tag}</Text>
                      ))}
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            {!editMode && displayedGroups.map(group => {
              const selected = group.id === activeSessionId;
              return (
                <TouchableOpacity
                  key={`group-${group.id}`}
                  style={[styles.characterCard, selected && styles.characterCardActive]}
                  onLayout={event => onCharacterItemLayout(`group-${group.id}`, event)}
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
                <TouchableOpacity onPress={() => clearImagePreview('avatar', setAvatarPreview)} hitSlop={8}>
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
                <TouchableOpacity onPress={() => clearImagePreview('bg', setBgPreview)} hitSlop={8}>
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

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={onImportToForge}
            disabled={!loaded}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="id-card-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>导入到制卡（AI 修改）</Text>
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
           <FieldLabel style={styles.label}>语音形态</FieldLabel>
           <View style={styles.chipRow}>
             {[
               { value: 'text', label: '仅文字' },
               { value: 'voice-text', label: '语音 + 原文' },
               { value: 'voice', label: '纯语音' },
             ].map(option => {
               const active = voiceDisplay === option.value;
               return (
                 <TouchableOpacity
                   key={option.value}
                   style={[styles.chip, active && styles.chipActive]}
                   onPress={() => setVoiceDisplay(option.value)}
                   activeOpacity={0.8}
                   accessibilityRole="button"
                   accessibilityLabel={`语音形态 ${option.label}`}
                   accessibilityState={{ selected: active }}
                 >
                   <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                 </TouchableOpacity>
               );
             })}
           </View>
           <FieldHint style={styles.fieldHint}>纯语音会隐藏回复正文，但正文仍会保存并进入对话记忆；合成失败时自动退回仅文字。</FieldHint>
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
            {tags.map((tag, index) => (
              <TouchableOpacity key={`${tag}-${index}`} style={styles.tagChip} onPress={() => removeTag(tag)} activeOpacity={0.8}>
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
              worldInfo.map((entry, index) => {
                const unsafeKeys = getUnsafeWorldEntryKeys(entry);
                return (
                  <SummaryRow
                    key={entry.id}
                    title={entry.comment || `条目 ${index + 1}`}
                    meta={[
                      worldEntryMeta(entry),
                      unsafeKeys.length > 0 ? `${unsafeKeys.length} 个关键词疑似回溯，已跳过` : '',
                    ].filter(Boolean).join('｜')}
                    enabled={entry.enabled}
                    onPress={() => setEditingWorldId(entry.id)}
                  />
                );
              })
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
                  meta={[
                    script.placementLabel || '',
                    isUnsafeRegexPattern(script.findRegex) ? '疑似回溯，运行时已跳过' : '',
                  ].filter(Boolean).join('｜')}
                  enabled={script.enabled}
                  onPress={() => setEditingRegexId(script.id)}
                />
              ))
            )}
          </CollapsibleSection>

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={() => setCharacterPresetPanelOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="sparkles-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>预设</Text>
            </View>
            <Text style={styles.presetEntryMeta}>{characterPresets.length}</Text>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={() => setPresetPanelOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="list-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>全局预设 / 记忆总结</Text>
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
        visible={characterPresetPanelOpen}
        scope="character"
        characterPresets={characterPresets}
        onCharacterPresetsChange={setCharacterPresets}
        onClose={() => setCharacterPresetPanelOpen(false)}
      />

      <PresetPanel
        visible={presetPanelOpen}
        onClose={() => setPresetPanelOpen(false)}
      />

      <GreetingPickerModal
        /*
         * 不要用 importing 控制 visible：导入失败时 visible 从 false 回到 true 会让
         * GreetingPickerModal 的 effect 用原始 candidates 重设 drafts，把用户改过/新增的
         * 开场白覆盖掉（与「你编辑的开场白仍会保留」的提示矛盾）。导入进度由下方
         * importStatus 遮罩单独承载，弹窗保持挂载即可保住草稿。
         */
        visible={!!pendingImport}
        candidates={pendingImport ? pendingImport.candidates : []}
        onCancel={() => setPendingImport(null)}
        onConfirm={confirmImport}
      />

      <Modal
        visible={!!importStatus}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.importOverlayBackdrop}>
          <View style={styles.importOverlayCard}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.importOverlayTitle}>{importStatusTitle}</Text>
            <Text style={styles.importOverlayHint}>{importStatusHint}</Text>
          </View>
        </View>
      </Modal>

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

      <ScrollScrubber
        visible={characterScrubberOpen && characterListExpanded && characterListNeedsCollapse}
        onClose={() => setCharacterScrubberOpen(false)}
        messageCount={displayedCharacterItems.length}
        previews={characterScrubberPreviews}
        onSeek={onCharacterScrubberSeek}
        onToStart={onCharacterScrubberToStart}
        onToEnd={onCharacterScrubberToEnd}
      />
    </KeyboardAvoidingView>
  );
}
