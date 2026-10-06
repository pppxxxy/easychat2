// 角色详情页（原「角色库 + 编辑表单」同页结构的表单半边）。
// 从 src/CharacterScreen.js 原样搬出「Card ② 基本信息 / Card ③ 人设设定 / Card ④ 角色数据」
// 三块及其全部表单 state / ref / effect / handler，只搬运不重写：
// 表单 seed、外部冲突检测、编辑草稿防抖、Tab 拦截信箱、图片三重守卫、保存闸门、
// 多选删除级联都保持原有顺序与文案。
//
// 结构性新增只有三处：顶部返回入口、route.params.characterId 取不到时的兜底、
// 以及「放弃并切换」分支里清草稿用的 activeId（原为同页 state，现在是 useApp 的 activeId）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
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
} from './cardParser.js';
import { exportCardFile } from './cardExporter.js';
import ChapterModal from '../books/ChapterModal.js';
import GreetingPickerModal from '../GreetingPickerModal.js';
import { listGreetingCandidates } from './cardGreetings.js';
import { Card, CollapsibleSection, FieldHint, FieldLabel, TextField, TopicButton } from '../ui/index.js';
import { useApp } from '../context/AppContext.js';
import { useNavigation, useRoute } from '@react-navigation/native';
import PresetPanel from '../PresetPanel.js';
import { compileRegex, isUnsafeRegexPattern } from '../prompt/regexEngine.js';
import { getUnsafeWorldEntryKeys } from '../prompt/lorebook.js';
import { maskSecrets } from '../storage/secrets.js';
import {
  getMomentsStatus,
  markMediaWrite,
  getUserProfile,
  saveCardForge,
  saveCharacterEditDraft,
  takeCharacterEditDraft,
  clearCharacterEditDraft,
} from '../storage.js';
import { isRecentMediaUri } from '../storage/mediaProtection.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createForgeState, draftFromCharacter } from '../cardForge/forge.js';
import { isFormDirty, setCharacterEditGuard } from './characterEditGuard.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createCharacterStyles } from './characterStyles.js';
import {
  DataField,
  RegexEntryEditor,
  SummaryRow,
  WorldEntryEditor,
} from './editors.js';
import {
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
} from './cardHelpers.js';

export default function CharacterDetailScreen() {
  const {
    character,
    characters,
    activeId,
    loaded,
    updateCharacter,
    switchCharacter,
    ensureCharacterSession,
    addCharacter,
    switchSession,
    sessions,
    activeSessionId,
  } = useApp();
  const navigation = useNavigation();
  const route = useRoute();
  const { t } = useTranslation();
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
  // 世界书/正则从「折叠区」升级为独立分段后，原来的 expandedWorld/expandedRegex
  // 展开态已由 segment 取代（新增条目、正则校验失败时切到对应段即可）。
  // 详情页分段（一层信息架构只做一件事：分段管大区块，折叠管组内分组）。
  // 不持久化：离开详情页即回到「人设」，保持「高频默认展开」的初始印象稳定。
  const [segment, setSegment] = useState('persona');
  // 人设段内各组的折叠状态。高频组默认展开（开场白/提示词），低频组默认折叠
  // （头像背景/细节设定/对话示例与标签），折叠时由分组容器给摘要行，
  // 做到「收起 ≠ 信息消失」。缺省即折叠，故这里只登记默认展开的组。
  const [openGroups, setOpenGroups] = useState({ greeting: true, prompt: true });
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
  const pendingImageUrisRef = useRef(new Map());
  const imageOperationRef = useRef(0);
  const mountedRef = useRef(true);
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

  // 兜底：拿不到 route 参数（例如从深层链接直接打开详情）时退回角色库，
  // 避免详情页读到一个不属于任何路由的角色。
  useEffect(() => {
    if (!route.params || !route.params.characterId) {
      navigation.replace('CharacterLibrary');
    }
  }, [route.params, navigation]);

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
            if (mountedRef.current) Alert.alert(t('character.detail.switchFail.title'), t('character.detail.switchFail.body'));
          })
          .finally(() => {
            if (revertingToRef.current === previousId) revertingToRef.current = '';
          });
      };
      Alert.alert(t('character.detail.dirtySwitch.title'), t('character.detail.dirtySwitch.body'), [
        { text: t('common.cancel'), style: 'cancel', onPress: revert },
        {
          text: t('character.detail.discardAndSwitch'),
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
        t('character.detail.draftFound.title'),
        t('character.detail.draftFound.body'),
        [
          { text: t('character.detail.draftFound.discard'), style: 'destructive' },
          {
            text: t('character.detail.draftFound.restore'),
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
    setSegment('world');
    const id = `entry-${Date.now().toString(36)}`;
    setWorldInfo(list => [
      ...list,
      createWorldEntry({
        id,
        comment: t('character.detail.worldEntryDefault', { n: list.length + 1 }),
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
    setSegment('regex');
    const id = `regex-${Date.now().toString(36)}`;
    setRegexScripts(list => [
      ...list,
      createRegexScript({
        id,
        name: t('character.detail.regexDefault', { n: list.length + 1 }),
      }),
    ]);
    setEditingRegexId(id);
  };

  // 返回布尔：true = 已落库（UI 同步可跳过不算失败）；false = 未保存。
  // 供 Tab 切换拦截的「保存并离开」判断是否切换。
  const saveInternal = async (options = {}) => {
    if (!loaded) {
      Alert.alert(t('character.detail.loading.title'), t('character.detail.loading.body'));
      return false;
    }
    if (!seededFormSignatureRef.current) {
      Alert.alert(t('character.detail.loading.title'), t('character.detail.loading.body'));
      return false;
    }
    if (formOwnerIdRef.current !== String(character.id || '')) {
      Alert.alert(t('character.detail.switched.title'), t('character.detail.switched.body'));
      return false;
    }
    if (externalConflictRef.current && options.force !== true) {
      Alert.alert(
        t('character.detail.externalConflict.title'),
        t('character.detail.externalConflict.body'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('character.detail.externalConflict.overwrite'), style: 'destructive', onPress: () => save({ force: true }) },
        ]
      );
      return false;
    }
    for (const [index, script] of regexScripts.entries()) {
      if (script.enabled === false) continue;
      try {
        compileRegex(script.findRegex, script.flags);
      } catch (error) {
        // 切到正则段：让用户直接看到出问题的那一条（原来是展开折叠区）。
        setSegment('regex');
        setEditingRegexId(script.id);
        Alert.alert(
          t('character.detail.regexInvalid.title'),
          maskSecrets(t('character.detail.regexInvalid.body', {
            index: index + 1,
            name: script.name || t('character.detail.unnamed'),
            error: error.message,
          }))
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
       Alert.alert(t('character.detail.saved.title'), t('character.detail.saved.body'));
       return true;
     } catch (error) {
       Alert.alert(
         error && error.code === 'CHARACTER_CONFLICT' ? t('character.detail.conflict.title') : t('common.error.saveFailed'),
         error && error.code === 'CHARACTER_CONFLICT'
           ? t('character.detail.conflict.body')
           : t('common.error.storageOrPermission')
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
        Alert.alert(t('character.detail.importReadError'));
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
        Alert.alert(t('character.detail.importTooLarge.title'), t('character.detail.importTooLarge.body', { size: formatImportSize(MAX_IMPORT_BYTES) }));
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
          Alert.alert(t('character.detail.importTooLarge.title'), t('character.detail.importTooLarge.body', { size: formatImportSize(MAX_IMPORT_BYTES) }));
          return;
        }
        const importSize = assetSize || buffer.length;
        setImportStatus({
          phase: 'reading',
          large: isLargeImport(importSize),
          size: importSize,
        });
      } catch (error) {
        Alert.alert(t('character.detail.importReadError'));
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
        Alert.alert(t('character.detail.importParseFail.title'), detail || t('character.detail.importParseFail.fallback'));
        return;
      }

      if (treatAsPng && parsed === null) {
        Alert.alert(t('character.detail.importEmpty.title'), NO_CARD_DATA_MESSAGE);
        return;
      }

      if (!hasCardContent(parsed)) {
        Alert.alert(t('character.detail.importEmpty.title'), t('character.detail.importEmpty.body'));
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
        // 导入新卡后回到人设段（原逻辑是收起世界书/正则折叠区）。
        setSegment('persona');
      }
      const summary = t('character.detail.importSummary.body', {
        name: next.name,
        world: next.worldInfo.length,
        regex: next.regexScripts.length,
        presets: next.presets.length,
        greeting: next.firstMes ? t('character.detail.importSummary.withGreeting') : t('character.detail.importSummary.noGreeting'),
      });
       Alert.alert(
         imageFailed ? t('character.detail.importOk.imageFailTitle') : t('character.detail.importOk.title'),
         imageFailed ? t('character.detail.importOk.imageFailBody', { summary }) : summary
       );
     } catch (error) {
       if (importedImageUri) {
         FileSystem.deleteAsync(importedImageUri, { idempotent: true }).catch(() => {});
       }
       const detail = maskSecrets(error?.message || String(error));

      const message = /角色库仍在恢复中/.test(detail)
        ? t('character.detail.importFail.keepGreeting', { detail })
        : /full|disk|空间|容量/i.test(detail)
          ? t('character.detail.importFail.diskFull')
          : t('character.detail.importFail.storage');
      Alert.alert(t('character.detail.importFail.title'), message);
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
            text: t('character.detail.forge.loadedNote', { name: editedCharacter.name || t('character.detail.unnamed') }),
            createdAt: Date.now(),
          },
          ...fresh.transcript.slice(1),
        ],
        updatedAt: Date.now(),
      })
        .then(() => navigation.navigate(ROUTE_NAMES.extension, { segment: 'forge', ts: Date.now() }))
        .catch(() => Alert.alert(t('character.detail.forge.loadFailTitle'), t('common.error.storageOrPermission')));
    };
    Alert.alert(
      t('character.detail.forge.title'),
      formDirty
        ? t('character.detail.forge.bodyDirty')
        : t('character.detail.forge.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('character.detail.forge.continue'), onPress: apply },
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
          dialogTitle: t('character.detail.export.dialogTitle'),
        });
      } else {
        Alert.alert(t('character.detail.export.doneTitle'), t('character.detail.export.doneBody', { uri }));
      }
    } catch (error) {
      Alert.alert(t('character.detail.export.failTitle'), maskSecrets((error && error.message) || t('common.error.retryLater')));
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  const onExport = () => {
    if (exportBusyRef.current || !loaded) return;
    Alert.alert(
      t('character.detail.export.dialogTitle'),
      formDirty
        ? t('character.detail.export.bodyDirty')
        : t('character.detail.export.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('character.detail.export.png'), onPress: () => runExport('png') },
        { text: t('character.detail.export.json'), onPress: () => runExport('json') },
      ]
    );
  };

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
      if (isCurrent()) Alert.alert(t('character.detail.imageReadFail.title'), t('character.detail.imageReadFail.body'));
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
      ? importStatus.phase === 'saving' ? t('character.detail.importStatus.largeSaving') : t('character.detail.importStatus.largeReading')
      : importStatus.phase === 'saving' ? t('character.detail.importStatus.saving') : t('character.detail.importStatus.reading');
  const importStatusHint = !importStatus
    ? ''
    : importStatus.large
      ? t(
        importStatus.phase === 'saving'
          ? 'character.detail.importStatus.hintWritingLarge'
          : 'character.detail.importStatus.hintParsingLarge',
        { size: importSizeLabel ? ` · ${importSizeLabel}` : '' }
      )
      : importStatus.phase === 'saving' ? t('character.detail.importStatus.hintSaving') : t('character.detail.importStatus.hintReading');

  // 人设段的分组容器：标题行可折叠，折叠时右侧渲染摘要（count）。
  // 复用统一后的 ui/CollapsibleSection（原 editors.js 那套参数不兼容的已合并掉），
  // 分组只负责把「展开态」提上来，便于按段重置。
  const renderPersonaGroup = (id, title, icon, summary, children) => {
    // 缺省折叠：只有显式登记为 true 的组默认展开（开场白/提示词）。
    const isOpen = openGroups[id] === true;
    return (
      <CollapsibleSection
        title={title}
        icon={icon}
        open={isOpen}
        onToggle={() => setOpenGroups(current => ({ ...current, [id]: !isOpen }))}
        count={summary}
      >
        {children}
      </CollapsibleSection>
    );
  };

  const SEGMENTS = [
    { id: 'persona', label: t('character.detail.segment.persona') },
    { id: 'world', label: t('character.detail.segment.world') },
    { id: 'regex', label: t('character.detail.segment.regex') },
    { id: 'presets', label: t('character.detail.segment.presets') },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        pointerEvents={formReady ? 'auto' : 'none'}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
      >
        <View style={styles.pageHeader}>
          {/* 详情页顶部返回入口：回到角色库列表 */}
          <TouchableOpacity
            style={styles.detailBackRow}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('character.detail.back')}
          >
            <Ionicons name="chevron-back" size={18} color={theme.colors.primarySoft} />
            <Text style={styles.detailBackText}>{t('character.detail.back')}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{(character && character.name) || t('common.characterFallback')}</Text>
          <FieldHint style={styles.hint}>{t('character.detail.headerHint')}</FieldHint>
        </View>

        {/* 分段控制：一层信息架构只做一件事——分段管大区块，折叠管组内分组 */}
        <View style={styles.segmentRow}>
          {SEGMENTS.map(item => {
            const active = segment === item.id;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.segmentChip, active && styles.segmentChipActive]}
                onPress={() => setSegment(item.id)}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.segmentChipText, active && styles.segmentChipTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {segment === 'persona' ? (
          <>
        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="create-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>{t('character.detail.basics.title')}</Text>
          </View>
          <FieldLabel style={styles.label}>{t('character.detail.basics.name')}</FieldLabel>
          <TextField
            value={name}
            onChangeText={setName}
            placeholder={t('character.detail.basics.namePlaceholder')}
          />
          {/* 头像/背景图属「基础」组，低频更换，默认折叠（摘要给「已设置/未设置」） */}
          {renderPersonaGroup(
            'basics',
            t('character.detail.basics.images'),
            'image-outline',
            [
              avatarPreview ? t('character.detail.basics.avatarSet') : t('character.detail.basics.avatarUnset'),
              bgPreview ? t('character.detail.basics.bgSet') : t('character.detail.basics.bgUnset'),
            ].join(' '),
            <>
              <Text style={styles.fieldLabel}>{t('character.detail.basics.avatar')}</Text>
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
                    <Text style={styles.smallButtonText}>{avatarPreview ? t('character.detail.basics.change') : t('character.detail.basics.pickAvatar')}</Text>
                  </TouchableOpacity>
                  {avatarPreview ? (
                    <TouchableOpacity onPress={() => clearImagePreview('avatar', setAvatarPreview)} hitSlop={8}>
                      <Text style={styles.removeText}>{t('character.detail.basics.clear')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              <Text style={styles.fieldLabel}>{t('character.detail.basics.bg')}</Text>
              <View style={styles.imageRow}>
                {bgPreview ? (
                  <Image source={{ uri: bgPreview }} style={styles.bgPreview} />
                ) : null}
                <View style={styles.imageActions}>
                  <TouchableOpacity style={styles.smallButton} onPress={pickBg} activeOpacity={0.8}>
                    <Text style={styles.smallButtonText}>{bgPreview ? t('character.detail.basics.change') : t('character.detail.basics.pickBg')}</Text>
                  </TouchableOpacity>
                  {bgPreview ? (
                    <TouchableOpacity onPress={() => clearImagePreview('bg', setBgPreview)} hitSlop={8}>
                      <Text style={styles.removeText}>{t('character.detail.basics.clear')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            </>
          )}

          <TouchableOpacity
            style={[styles.importButton, (importing || !loaded) && styles.buttonDisabled]}
            onPress={importCard}
            disabled={importing || !loaded}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.importButtonText}>
              {importing ? t('character.detail.import.importing') : t('character.detail.import.button')}
            </Text>
          </TouchableOpacity>
          <Text style={styles.importHint}>{t('character.detail.import.hint')}</Text>
          <TopicButton
            style={styles.topicButton}
            onPress={() => setTopic('character-card')}
            accessibilityLabel={t('character.detail.import.a11yTutorial')}
          />

          <TouchableOpacity
            style={styles.presetEntryRow}
            onPress={onExport}
            disabled={exporting || !loaded}
            activeOpacity={0.7}
          >
            <View style={styles.presetEntryLeft}>
              <Ionicons name="share-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.presetEntryText}>
                {exporting ? t('character.detail.export.exporting') : t('character.detail.export.dialogTitle')}
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
              <Text style={styles.presetEntryText}>{t('character.detail.forge.entry')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>

        </Card>

        <Card>
          <View style={styles.cardTitleRow}>
            <Ionicons name="sparkles-outline" size={16} color={theme.colors.primaryMuted} />
            <Text style={styles.cardTitle}>{t('character.detail.persona.title')}</Text>
          </View>
          {renderPersonaGroup(
            'greeting',
            t('character.detail.greeting.group'),
            'chatbubble-ellipses-outline',
            firstMes ? `${firstMes.slice(0, 12)}…` : t('character.detail.notSet'),
            <>
          <FieldLabel style={styles.label}>{t('character.detail.greeting.group')}</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={firstMes}
            onChangeText={setFirstMes}
            placeholder={t('character.detail.greeting.placeholder')}
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>{t('character.detail.greeting.alternates')}</FieldLabel>
          {alternateGreetings.map((item, index) => (
            <View key={`greeting-${index}`} style={styles.greetingRow}>
              <TextField
                style={[styles.multilineSmall, styles.greetingInput]}
                value={item}
                onChangeText={value => updateGreeting(index, value)}
                placeholder={t('character.detail.greeting.alternatePlaceholder', { n: index + 1 })}
                multiline
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={styles.greetingRemove}
                onPress={() => removeGreeting(index)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('character.detail.greeting.a11yRemove')}
              >
                <Ionicons name="close" size={16} color={theme.colors.dangerSoft} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={styles.secondaryButton} onPress={addGreeting} activeOpacity={0.8}>
            <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.secondaryButtonText}>{t('character.detail.greeting.add')}</Text>
          </TouchableOpacity>
            </>
          )}
          {renderPersonaGroup(
            'prompt',
            t('character.detail.prompt.group'),
            'document-text-outline',
            systemPrompt ? t('character.detail.charCount', { count: systemPrompt.length }) : t('character.detail.notSet'),
            <>
          <FieldLabel style={styles.label}>{t('character.detail.prompt.label')}</FieldLabel>
           <TextField
             style={styles.multiline}
             value={systemPrompt}
             onChangeText={setSystemPrompt}
             placeholder={t('character.detail.prompt.placeholder')}
             multiline
             textAlignVertical="top"
           />
           <FieldLabel style={styles.label}>{t('character.detail.voice.label')}</FieldLabel>
           <View style={styles.chipRow}>
             {[
               { value: 'text', label: t('character.detail.voice.text') },
               { value: 'voice-text', label: t('character.detail.voice.voiceText') },
               { value: 'voice', label: t('character.detail.voice.voiceOnly') },
             ].map(option => {
               const active = voiceDisplay === option.value;
               return (
                 <TouchableOpacity
                   key={option.value}
                   style={[styles.chip, active && styles.chipActive]}
                   onPress={() => setVoiceDisplay(option.value)}
                   activeOpacity={0.8}
                   accessibilityRole="button"
                   accessibilityLabel={t('character.detail.voice.a11y', { label: option.label })}
                   accessibilityState={{ selected: active }}
                 >
                   <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                 </TouchableOpacity>
               );
             })}
           </View>
           <FieldHint style={styles.fieldHint}>{t('character.detail.voice.hint')}</FieldHint>
            </>
          )}
          {renderPersonaGroup(
            'details',
            t('character.detail.details.group'),
            'reader-outline',
            t('character.detail.details.count', { count: [description, personality, scenario].filter(value => String(value || '').trim()).length }),
            <>
           <FieldLabel style={styles.label}>{t('character.detail.details.description')}</FieldLabel>
          <TextField
            style={styles.multiline}
            value={description}
            onChangeText={setDescription}
            placeholder={t('character.detail.details.descriptionPlaceholder')}
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>{t('character.detail.details.personality')}</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={personality}
            onChangeText={setPersonality}
            placeholder={t('character.detail.details.personalityPlaceholder')}
            multiline
            textAlignVertical="top"
          />
          <FieldLabel style={styles.label}>{t('character.detail.details.scenario')}</FieldLabel>
          <TextField
            style={styles.multilineSmall}
            value={scenario}
            onChangeText={setScenario}
            placeholder={t('character.detail.details.scenarioPlaceholder')}
            multiline
            textAlignVertical="top"
          />
            </>
          )}

          {renderPersonaGroup(
            'examples',
            t('character.detail.examples.group'),
            'chatbox-outline',
            mesExample ? t('character.detail.charCount', { count: mesExample.length }) : t('character.detail.notSet'),
            <>
          <FieldLabel style={styles.label}>{t('character.detail.examples.group')}</FieldLabel>
          <TextField
            style={styles.multiline}
            value={mesExample}
            onChangeText={setMesExample}
            placeholder={t('character.detail.examples.placeholder')}
            multiline
            textAlignVertical="top"
          />
          <Text style={styles.fieldHint}>{t('character.detail.examples.hint')}</Text>
            </>
          )}

          {renderPersonaGroup(
            'tags',
            t('character.detail.tags.group'),
            'pricetags-outline',
            tags.length > 0 ? t('character.detail.tags.count', { count: tags.length }) : t('character.detail.notSet'),
            <>
          <FieldLabel style={styles.label}>{t('character.detail.tags.group')}</FieldLabel>
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
              placeholder={t('character.detail.tags.placeholder')}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.tagAdd} onPress={addTag} activeOpacity={0.8}>
              <Ionicons name="add" size={18} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
          </View>
            </>
          )}
        </Card>

        {/* 导入卡带来的只读资料：不参与编辑，随人设段一起展示 */}
        {card.creatorNotes || card.postHistoryInstructions || card.tags?.length ? (
          <Card>
            <View style={styles.cardTitleRow}>
              <Ionicons name="albums-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('character.detail.rawCard.title')}</Text>
            </View>
            {card.creatorNotes || card.postHistoryInstructions ? (
              <View style={styles.dataSection}>
                <Text style={styles.dataTitle}>{t('character.detail.rawCard.other')}</Text>
                <DataField label={t('character.detail.rawCard.creatorNotes')} value={card.creatorNotes} />
                <DataField label={t('character.detail.rawCard.postHistory')} value={card.postHistoryInstructions} />
              </View>
            ) : null}
            {card.tags?.length ? (
              <View style={styles.dataSection}>
                <Text style={styles.dataTitle}>{t('character.detail.rawCard.tags')}</Text>
                <View style={styles.tagRow}>
                  {card.tags.map((tag, index) => (
                    <View key={`${tag}-${index}`} style={styles.tag}>
                      <Text style={styles.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </Card>
        ) : null}
          </>
        ) : null}

        {/* 保存按钮不随分段隐藏：保存的是整份表单（含世界书/正则/预设） */}
        <TouchableOpacity
          style={[styles.button, !loaded && styles.buttonDisabled, styles.saveButton]}
          onPress={save}
          disabled={!loaded}
          activeOpacity={0.85}
        >
          <Ionicons name="save-outline" size={17} color={theme.colors.text} />
          <Text style={styles.buttonText}>{t('character.detail.save')}</Text>
        </TouchableOpacity>

        {segment === 'world' ? (
          <Card>
            <View style={styles.cardTitleRow}>
              <Ionicons name="book-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('character.detail.segment.world')}</Text>
              <Text style={styles.sectionCount}>{worldInfo.length}</Text>
            </View>
            <Text style={styles.cardHint}>{t('character.detail.world.hint')}</Text>
            {worldInfo.length === 0 ? (
              <Text style={styles.dataEmpty}>{t('character.detail.world.empty')}</Text>
            ) : (
              worldInfo.map((entry, index) => {
                const unsafeKeys = getUnsafeWorldEntryKeys(entry);
                return (
                  <SummaryRow
                    key={entry.id}
                    title={entry.comment || t('character.detail.world.entryFallback', { n: index + 1 })}
                    meta={[
                      worldEntryMeta(entry),
                      unsafeKeys.length > 0 ? t('character.detail.world.unsafeMeta', { count: unsafeKeys.length }) : '',
                    ].filter(Boolean).join('｜')}
                    enabled={entry.enabled}
                    onPress={() => setEditingWorldId(entry.id)}
                  />
                );
              })
            )}
            <TouchableOpacity style={styles.addEntryButton} onPress={addWorldEntry} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.addEntryText}>{t('character.detail.world.add')}</Text>
            </TouchableOpacity>
          </Card>
        ) : null}

        {segment === 'regex' ? (
          <Card>
            <View style={styles.cardTitleRow}>
              <Ionicons name="code-slash-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('character.detail.regex.title')}</Text>
              <Text style={styles.sectionCount}>{regexScripts.length}</Text>
            </View>
            <Text style={styles.cardHint}>{t('character.detail.regex.hint')}</Text>
            {regexScripts.length === 0 ? (
              <Text style={styles.dataEmpty}>{t('character.detail.regex.empty')}</Text>
            ) : (
              regexScripts.map((script, index) => (
                <SummaryRow
                  key={script.id}
                  title={script.name || t('character.detail.regex.fallback', { n: index + 1 })}
                  meta={[
                    script.placementLabel || '',
                    isUnsafeRegexPattern(script.findRegex) ? t('character.detail.regex.unsafe') : '',
                  ].filter(Boolean).join('｜')}
                  enabled={script.enabled}
                  onPress={() => setEditingRegexId(script.id)}
                />
              ))
            )}
            <TouchableOpacity style={styles.addEntryButton} onPress={addRegexScript} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.addEntryText}>{t('character.detail.regex.add')}</Text>
            </TouchableOpacity>
          </Card>
        ) : null}

        {segment === 'presets' ? (
          <Card>
            <View style={styles.cardTitleRow}>
              <Ionicons name="sparkles-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>{t('character.detail.segment.presets')}</Text>
            </View>
            <Text style={styles.cardHint}>{t('character.detail.presets.hint')}</Text>
            <TouchableOpacity
              style={styles.presetEntryRow}
              onPress={() => setCharacterPresetPanelOpen(true)}
              activeOpacity={0.7}
            >
              <View style={styles.presetEntryLeft}>
                <Ionicons name="sparkles-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.presetEntryText}>{t('character.detail.presets.character')}</Text>
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
                <Text style={styles.presetEntryText}>{t('settings.global.presets')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </TouchableOpacity>
          </Card>
        ) : null}

        <View style={{ height: 24 }} />
      </ScrollView>

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
        title={t('settings.tutorial.title')}
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
              <Text style={styles.modalTitle}>{t('character.detail.world.editTitle')}</Text>
              <TouchableOpacity
                onPress={() => setEditingWorldId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>{t('common.done')}</Text>
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
              <Text style={styles.modalTitle}>{t('character.detail.regex.editTitle')}</Text>
              <TouchableOpacity
                onPress={() => setEditingRegexId(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalDone}>{t('common.done')}</Text>
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
