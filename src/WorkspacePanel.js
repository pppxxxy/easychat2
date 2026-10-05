// 工作区面板：浏览当前「工作区角色」沙盒内的文本/Markdown 与导出的 .docx。
// - 文本文件：预览、复制、分享、删除；
// - 可改模式：新建文本、把一段文本导出为 Word（.docx），并分享；
// - 工作区角色：面板顶部选择（默认落到「EasyChat2 工作助手」，不存在时自动建卡）；
//   文件按角色分沙盒，与该角色在聊天里用工具读写的是同一个目录；
// - 查看文件：独立入口（文件夹按钮），分「已创建的文件 / 历史改动」两段；
//   历史改动 = 经后端写入/编辑/删除的记录（面板与聊天工具共用同一条记录路径）。
// 入口在「设置 → 工作区」卡片。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';

import { EmptyState, FieldHint, FieldLabel, GhostButton, PrimaryButton, SheetHeader, TextField } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { useApp } from './context/AppContext.js';
import {
  capabilitiesForModel,
  clearWorkspaceChanges,
  getActiveLocalModel,
  getActiveModel,
  getApiConfigs,
  getCharacterLibrary,
  getMessagesBySession,
  getSessions,
  getThinkingSettings,
  getWorkspaceChanges,
  getWorkspaceSettings,
  patchWorkspaceSettings,
  saveThinkingSettings,
} from './storage.js';
import { resolveWorkspaceAssistant } from './workspace/assistant.js';
import { AUTO_COMPACT_RATIO, computeContextUsage, resolveContextWindow } from './chat/contextUsage.js';
import { normalizeLocalModelParams } from './localModel/modelParams.js';
import { buildDocxBytes, bytesToBase64, splitDocxParagraphs } from './workspace/docx.js';
import { createWorkspaceStore, describeWorkspaceRoot } from './workspace/native.js';
import WorkspaceChat from './workspace/WorkspaceChat.js';
import { isAllowedWorkspaceFile, isAllowedWorkspaceOutputFile } from './workspace/paths.js';
import { ensureDocxFileName, ensureDirectoryName, ensureTextFileName, isDocxName, sanitizeWorkspaceFileName } from './workspace/naming.js';
import { WORKSPACE_ROOT_KINDS } from './workspace/location.js';
import { CATALOG_CATEGORIES, catalogItemsByCategory, buildCatalogContent, findCatalogItem } from './workspace/catalog.js';

const MODE_LABEL_KEY = { ask: 'settings.workspace.mode.ask', read: 'settings.workspace.mode.read', write: 'settings.workspace.mode.write' };

// 改动记录的展示辅助（时间手写格式化：Hermes 的 Intl 支持不完整，不依赖 toLocaleString）。
function formatChangeTime(at) {
  const date = new Date(Number(at) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CHANGE_OP_META = {
  write: { icon: 'document-text-outline', labelKey: 'workspace.panel.history.op.write' },
  edit: { icon: 'create-outline', labelKey: 'workspace.panel.history.op.edit' },
  delete: { icon: 'trash-outline', labelKey: 'workspace.panel.history.op.delete' },
};

// 思考强度四档；off = 关闭思考（enabled: false），其余对应 level。
const THINKING_CHOICES = ['off', 'low', 'medium', 'high'];

// token 数的紧凑显示（估算值，K 足够）。
function formatTokens(value) {
  const tokens = Number(value) || 0;
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}K`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

export default function WorkspacePanel({ visible, onClose, characterId: initialCharacterId = 'default', initialSection = '' }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const { characters, refreshAppData } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [mode, setMode] = useState('ask');
  const [chatOpen, setChatOpen] = useState(false);
  // 根可能被用户在设置里改（应用内默认 ↔ 外部文件夹），故随设置变化而不是一次算死。
  const [root, setRoot] = useState(() => describeWorkspaceRoot(null));
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  // 编辑表单：{ kind:'text'|'docx', name, content } | null
  const [form, setForm] = useState(null);
  // 工作区角色：打开时按设置解析；未设置则落到默认工作助手（不存在时自动建卡）。
  // 变量名保持 characterId（store 调用的 shorthand 语义不变）。
  const [characterId, setCharacterId] = useState(initialCharacterId);
  const [workspaceCharacter, setWorkspaceCharacter] = useState(null);
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false);
  const [pickerCharacters, setPickerCharacters] = useState([]);
  // 查看文件：文件列表与历史改动两段。
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerTab, setViewerTab] = useState('files');
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [expandedChangeId, setExpandedChangeId] = useState('');
  // 环境与配置下载：目录弹层、需输入的模板表单（.gitconfig 的提交身份）、自定义 URL。
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogInputs, setCatalogInputs] = useState({});
  const [catalogBusyId, setCatalogBusyId] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customBusy, setCustomBusy] = useState(false);
  // 思考强度（全局设置，作用于聊天；含工作区角色的会话）。
  const [thinking, setThinking] = useState({ enabled: false, level: 'medium' });
  // 上下文占用（工作区角色的最近一个会话；null = 无会话）。
  const [usage, setUsage] = useState(null);
  // 打开面板那一刻的后端。中途用户在设置里改根时，面板内的操作仍按打开时的根走，
  // 避免「列出来的是 A 文件夹的文件、删的却是 B 文件夹」。
  const storeRef = useRef(null);
  // 指令对话框登记工具时需要完整设置快照（模式/根/命令执行开关），随面板一起冻结。
  const settingsRef = useRef(null);
  const mountedRef = useRef(true);

  const canWrite = mode === 'write';
  const external = root.kind === WORKSPACE_ROOT_KINDS.SAF;
  const characterName = (Array.isArray(characters) ? characters : [])
    .find(item => item && item.id === characterId)?.name || '';

  const refresh = useCallback(async (ownerId = characterId) => {
    const store = storeRef.current;
    if (!store) {
      setError(t('workspace.panel.err.fileSystem'));
      return;
    }
    setLoading(true);
    try {
      const list = await store.listWorkspaceFiles({ characterId: ownerId });
      if (!mountedRef.current) return;
      setFiles(list);
      setError('');
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(t('workspace.panel.err.read'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [characterId, t]);

  // 上下文占用：取该工作区角色最近的一个单聊会话，按当前后端声明的窗口估算。
  // 与 ChatScreen.maybeAutoSummarize 同一口径（chat/contextUsage.js），到 80% 自动压缩。
  const loadContextUsage = useCallback(async ownerId => {
    try {
      const [sessions, { configs, activeId }, localItem] = await Promise.all([
        getSessions(),
        getApiConfigs(),
        getActiveLocalModel().catch(() => null),
      ]);
      const session = (Array.isArray(sessions) ? sessions : [])
        .filter(item => item && item.type !== 'group'
          && String(item.characterId || '') === String(ownerId || ''))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
      if (!session) {
        if (mountedRef.current) setUsage(null);
        return;
      }
      const messages = await getMessagesBySession(session.id).catch(() => []);
      const current = configs.find(item => item.id === activeId) || configs[0];
      const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
      const localContextSize = localItem ? normalizeLocalModelParams(localItem).contextSize : 0;
      const computed = computeContextUsage(messages, resolveContextWindow({
        declared: caps.contextWindow,
        localContextSize,
      }));
      if (mountedRef.current) setUsage(computed);
    } catch (error) {
      if (mountedRef.current) setUsage(null);
    }
  }, []);

  // 思考强度：off = 关闭思考；其余档位对应 low/medium/high（全局设置，保存即生效）。
  const updateThinking = useCallback(async choice => {
    if (!THINKING_CHOICES.includes(choice)) return;
    const next = {
      enabled: choice !== 'off',
      level: choice === 'off' ? thinking.level : choice,
      display: thinking.display || 'fold',
    };
    setThinking(next);
    try {
      const saved = await saveThinkingSettings(next);
      if (mountedRef.current) setThinking(saved);
    } catch (error) {
      // 保存失败时回读兜底，避免界面与存储漂移。
      getThinkingSettings()
        .then(current => { if (mountedRef.current && current) setThinking(current); })
        .catch(() => {});
    }
  }, [thinking]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!visible) return;
    setPreview(null);
    setForm(null);
    setViewerOpen(false);
    setCharacterPickerOpen(false);
    setChatOpen(false);
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        if (!mountedRef.current) return;
        setMode(settings.mode);
        setRoot(describeWorkspaceRoot(settings));
        settingsRef.current = settings;
        try {
          storeRef.current = createWorkspaceStore(settings);
        } catch (caught) {
          // 外部根但新 API 不可用（例如装了旧版原生模块）：如实报错，绝不偷偷写回应用沙盒。
          storeRef.current = null;
          setError(t('workspace.panel.err.externalUnavailable'));
          setFiles([]);
          setLoading(false);
          return;
        }
        // 解析工作区角色：设置里有且命中就用它；否则落到默认工作助手；都没有则回落内置助手。
        // 不再自动建卡——用户删掉的工作助手不会复活，面板始终有角色可用。
        const resolved = await resolveWorkspaceAssistant(settings.assistantCharacterId);
        if (!mountedRef.current) return;
        if (resolved.character) {
          setWorkspaceCharacter(resolved.character);
          setCharacterId(resolved.id);
          if (resolved.persist) {
            patchWorkspaceSettings({ assistantCharacterId: resolved.id }).catch(() => {});
          }
          if (resolved.created) {
            // 新建了助手卡：同步 AppContext 的角色列表，角色页无需重启即可见。
            refreshAppData().catch(() => {});
          }
        }
        // 思考强度（全局设置）+ 上下文占用（工作区角色的最近会话）。
        const thinkingSettings = await getThinkingSettings().catch(() => null);
        if (!mountedRef.current) return;
        if (thinkingSettings) setThinking(thinkingSettings);
        loadContextUsage(resolved.id || undefined);
        refresh(resolved.id || undefined);
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(t('workspace.panel.err.read'));
      }
    })();
  }, [visible, refresh, t, refreshAppData, loadContextUsage]);

  const fileUri = useCallback(async name => {
    const store = storeRef.current;
    if (!store) return null;
    try {
      return await store.fileUri({ characterId, path: name });
    } catch (caught) {
      return null;
    }
  }, [characterId]);

  const shareFile = useCallback(async name => {
    const store = storeRef.current;
    try {
      const uri = await fileUri(name);
      if (!uri) {
        Alert.alert(t('workspace.panel.err.share'), t('workspace.panel.err.open'));
        return;
      }
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(uri, { dialogTitle: t('workspace.panel.share.dialog', { name }) });
        return;
      }
      if (isAllowedWorkspaceFile(name)) {
        const result = await store.readWorkspaceFile({ characterId, path: name });
        await Clipboard.setStringAsync(result.content);
        Alert.alert(t('workspace.panel.copied.title'), t('workspace.panel.copied.body'));
        return;
      }
      Alert.alert(t('workspace.panel.err.share'), t('workspace.panel.err.shareUnsupported'));
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.share'), t('workspace.panel.err.share'));
    }
  }, [characterId, fileUri, t]);

  const openFile = useCallback(async name => {
    if (String(name || '').endsWith('/')) return;
    if (!isAllowedWorkspaceFile(name)) {
      shareFile(name);
      return;
    }
    const store = storeRef.current;
    if (!store) return;
    try {
      const result = await store.readWorkspaceFile({ characterId, path: name });
      if (mountedRef.current) setPreview(result);
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.open'), t('workspace.panel.err.open'));
    }
  }, [characterId, shareFile, t]);

  const handleDelete = useCallback(name => {
    Alert.alert(t('workspace.panel.delete.title'), t('workspace.panel.delete.body', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          const store = storeRef.current;
          if (!store) return;
          store.deleteFile({ characterId, path: name })
            .then(() => {
              if (!mountedRef.current) return;
              setFiles(list => list.filter(entry => entry !== name));
              if (preview && preview.path === name) setPreview(null);
            })
            .catch(() => Alert.alert(t('workspace.panel.err.delete'), t('workspace.panel.err.delete')));
        },
      },
    ]);
  }, [characterId, preview, t]);

  const startTextForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    setForm({ kind: 'text', name: '', content: '' });
  }, [canWrite, t]);

  const startFolderForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    setForm({ kind: 'folder', name: '', content: '' });
  }, [canWrite, t]);

  const startDocxForm = useCallback(() => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    setForm({ kind: 'docx', name: '', content: '' });
  }, [canWrite, t]);

  const submitForm = useCallback(async () => {
    if (!form) return;
    const store = storeRef.current;
    if (!store) return;
    const content = String(form.content || '');
    try {
      if (form.kind === 'folder') {
        const path = ensureDirectoryName(form.name);
        await store.createWorkspaceDirectory({ characterId, path });
      } else if (form.kind === 'text') {
        const path = ensureTextFileName(form.name);
        await store.writeWorkspaceFile({ characterId, path, content });
      } else {
        const path = ensureDocxFileName(form.name);
        const bytes = buildDocxBytes({
          title: sanitizeWorkspaceFileName(form.name, ''),
          paragraphs: splitDocxParagraphs(content),
        });
        await store.writeWorkspaceBinaryFile({ characterId, path, base64: bytesToBase64(bytes) });
      }
      if (!mountedRef.current) return;
      setForm(null);
      await refresh();
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
    }
  }, [characterId, form, refresh, t]);

  const modeLabel = t(MODE_LABEL_KEY[mode] || MODE_LABEL_KEY.ask);
  const characterLabel = workspaceCharacter ? String(workspaceCharacter.name || workspaceCharacter.id) : characterId;

  const openCharacterPicker = useCallback(async () => {
    try {
      const list = await getCharacterLibrary();
      if (!mountedRef.current) return;
      setPickerCharacters(Array.isArray(list) ? list : []);
    } catch (error) {
      if (mountedRef.current) setPickerCharacters([]);
    }
    setCharacterPickerOpen(true);
  }, []);

  const selectWorkspaceCharacter = useCallback(item => {
    if (!item || !item.id) return;
    setCharacterPickerOpen(false);
    setWorkspaceCharacter(item);
    setCharacterId(item.id);
    patchWorkspaceSettings({ assistantCharacterId: item.id }).catch(() => {});
    refresh(item.id);
  }, [refresh]);

  // 从工作区主界面的设置列表跳进来时，直接打开对应子面板：
  // viewer = 已创建文件 / 历史改动，catalog = 环境配置模板，docx = 导出 Word。
  // 用 ref 记住已处理过的 section：面板打开期间用户手动关掉子面板后不再被重新弹开。
  const openedSectionRef = useRef('');
  useEffect(() => {
    if (!visible) {
      openedSectionRef.current = '';
      return;
    }
    const section = String(initialSection || '');
    if (!section || openedSectionRef.current === section) return;
    openedSectionRef.current = section;
    if (section === 'viewer') {
      setViewerTab('history');
      setViewerOpen(true);
    } else if (section === 'catalog') {
      setCatalogOpen(true);
    } else if (section === 'docx') {
      startDocxForm();
    }
  }, [visible, initialSection, startDocxForm]);

  const loadChanges = useCallback(async ownerId => {
    setChangesLoading(true);
    try {
      const list = await getWorkspaceChanges(ownerId || characterId);
      if (mountedRef.current) setChanges(list);
    } catch (error) {
      if (mountedRef.current) setChanges([]);
    } finally {
      if (mountedRef.current) setChangesLoading(false);
    }
  }, [characterId]);

  const openViewer = useCallback(tab => {
    setViewerTab(tab === 'history' ? 'history' : 'files');
    setExpandedChangeId('');
    setViewerOpen(true);
    if (tab === 'history') loadChanges();
  }, [loadChanges]);

  const clearHistory = useCallback(() => {
    Alert.alert(t('workspace.panel.viewer.clear.title'), t('workspace.panel.viewer.clear.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          clearWorkspaceChanges(characterId)
            .then(() => { if (mountedRef.current) setChanges([]); })
            .catch(() => {});
        },
      },
    ]);
  }, [characterId, t]);

  // —— 环境与配置下载 ——
  // 写入走 store.writeWorkspaceFile：与面板手写同一条路径，自动进历史改动。
  const writeCatalogFile = useCallback(async (path, content) => {
    const store = storeRef.current;
    if (!store) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
      return;
    }
    try {
      await store.writeWorkspaceFile({ characterId, path, content });
      if (!mountedRef.current) return;
      await refresh();
      Alert.alert(t('workspace.panel.catalog.doneTitle'), t('workspace.panel.catalog.doneBody', { file: path }));
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
    }
  }, [characterId, refresh, t]);

  const handleCatalogWrite = useCallback(async itemId => {
    const item = findCatalogItem(itemId);
    if (!item || catalogBusyId) return;
    setCatalogBusyId(itemId);
    try {
      const content = buildCatalogContent(item, catalogInputs[itemId] || {});
      await writeCatalogFile(item.file, content);
    } finally {
      if (mountedRef.current) setCatalogBusyId('');
    }
  }, [catalogBusyId, catalogInputs, writeCatalogFile]);

  // 自定义 URL 下载：仅 https、20s 超时、512KB 上限；文件名取 URL 末段再过命名清洗。
  const handleCustomDownload = useCallback(async () => {
    if (customBusy) return;
    const url = String(customUrl || '').trim();
    if (!/^https:\/\//.test(url)) {
      Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errHttp'));
      return;
    }
    setCustomBusy(true);
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { if (controller) controller.abort(); }, 20000);
      let response;
      try {
        response = await fetch(url, { signal: controller ? controller.signal : undefined });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 512 * 1024) {
        Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errSize'));
        return;
      }
      const rawName = url.split('/').pop().split('?')[0] || 'download.txt';
      // 白名单内的名字（如 .gitignore）原样保留；其余走命名清洗并补 .txt。
      const path = isAllowedWorkspaceOutputFile(rawName)
        ? rawName
        : ensureTextFileName(sanitizeWorkspaceFileName(rawName, 'download'));
      await writeCatalogFile(path, text);
      setCustomUrl('');
    } catch (caught) {
      Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errFetch'));
    } finally {
      if (mountedRef.current) setCustomBusy(false);
    }
  }, [customBusy, customUrl, t, writeCatalogFile]);

  // 文件行渲染（主列表与「查看文件」共用同一份，避免两处漂移）。
  const renderFileRow = name => (
    <View key={name} style={styles.fileRow}>
      <TouchableOpacity style={styles.fileMain} onPress={() => openFile(name)} activeOpacity={0.8}>
        <Ionicons
          name={String(name).endsWith('/') ? 'folder-outline' : (isDocxName(name) ? 'document-outline' : 'document-text-outline')}
          size={16}
          color={theme.colors.primaryMuted}
        />
        <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
      </TouchableOpacity>
      {!String(name).endsWith('/') ? (
        <>
          <TouchableOpacity style={styles.fileAction} onPress={() => shareFile(name)} accessibilityLabel={t('workspace.panel.a11y.share', { name })}>
            <Ionicons name="share-outline" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.fileAction} onPress={() => handleDelete(name)} accessibilityLabel={t('workspace.panel.a11y.delete', { name })}>
            <Ionicons name="trash-outline" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <SheetHeader title={t('workspace.panel.title')} onClose={onClose} />

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.modeRow}>
            <Ionicons name="briefcase-outline" size={15} color={theme.colors.primaryMuted} />
            <Text style={styles.modeText}>
              {t('workspace.panel.mode.prefix')}{modeLabel}
              {canWrite ? t('workspace.panel.mode.suffixWrite') : t('workspace.panel.mode.suffixReadonly')}
            </Text>
          </View>
          <Text style={styles.sandboxHint} numberOfLines={1}>
            {external
              ? t('workspace.panel.sandbox.external', { folder: root.name || t('settings.workspace.folder.custom'), name: characterLabel })
              : t('workspace.panel.sandbox', { name: characterLabel })}
          </Text>
          {external ? (
            <Text style={styles.sandboxHint} numberOfLines={2}>{t('workspace.panel.sandbox.externalHint')}</Text>
          ) : null}

          <View style={styles.characterRow}>
            <View style={styles.characterAvatar}>
              {workspaceCharacter && workspaceCharacter.avatarUri ? (
                <Image source={{ uri: workspaceCharacter.avatarUri }} style={styles.characterAvatarImage} />
              ) : (
                <Text style={styles.characterAvatarText}>{(characterLabel || '?').slice(0, 1)}</Text>
              )}
            </View>
            <View style={styles.characterText}>
              <Text style={styles.characterName} numberOfLines={1}>
                {t('workspace.panel.character.label')}{' · '}{characterLabel}
              </Text>
              <Text style={styles.characterHint} numberOfLines={2}>{t('workspace.panel.character.hint')}</Text>
            </View>
            <TouchableOpacity style={styles.characterSelectButton} onPress={openCharacterPicker} activeOpacity={0.85}>
              <Text style={styles.characterSelectText}>{t('workspace.panel.character.select')}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.controlCard}>
            <FieldLabel>{t('workspace.panel.thinking.label')}</FieldLabel>
            <View style={styles.thinkingChips}>
              {THINKING_CHOICES.map(choice => {
                const active = choice === 'off'
                  ? thinking.enabled !== true
                  : thinking.enabled === true && thinking.level === choice;
                return (
                  <TouchableOpacity
                    key={choice}
                    style={[styles.thinkingChip, active && styles.thinkingChipActive]}
                    onPress={() => updateThinking(choice)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.thinkingChipText, active && styles.thinkingChipTextActive]}>
                      {t(`workspace.panel.thinking.${choice}`)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldHint>{t('workspace.panel.thinking.hint')}</FieldHint>
          </View>

          <View style={styles.controlCard}>
            <FieldLabel>{t('workspace.panel.context.label')}</FieldLabel>
            {usage ? (
              <>
                <View style={styles.contextBar}>
                  <View
                    style={[
                      styles.contextFill,
                      usage.ratio >= AUTO_COMPACT_RATIO && styles.contextFillWarn,
                      { width: `${Math.min(100, Math.max(2, Math.round(usage.ratio * 100)))}%` },
                    ]}
                  />
                </View>
                <Text style={styles.contextText}>
                  {t('workspace.panel.context.usage', {
                    tokens: formatTokens(usage.tokens),
                    window: formatTokens(usage.window),
                    percent: Math.round(usage.ratio * 100),
                  })}
                </Text>
              </>
            ) : (
              <Text style={styles.contextText}>{t('workspace.panel.context.empty')}</Text>
            )}
            <FieldHint>{t('workspace.panel.context.hint')}</FieldHint>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startFolderForm}
              activeOpacity={0.85}
            >
              <Ionicons name="folder-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.newFolder')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startTextForm}
              activeOpacity={0.85}
            >
              <Ionicons name="document-text-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.newText')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startDocxForm}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.exportWord')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => openViewer('files')}
              activeOpacity={0.85}
            >
              <Ionicons name="folder-open-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.viewFiles')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => setCatalogOpen(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.actionText}>{t('workspace.panel.catalog.entry')}</Text>
            </TouchableOpacity>
          </View>

          {form ? (
            <View style={styles.formCard}>
              <FieldLabel>
                {form.kind === 'folder'
                  ? t('workspace.panel.form.newFolder')
                  : (form.kind === 'text' ? t('workspace.panel.form.newText') : t('workspace.panel.form.exportWord'))}
              </FieldLabel>
              <TextField
                style={styles.input}
                placeholder={form.kind === 'folder'
                  ? t('workspace.panel.form.nameFolder')
                  : (form.kind === 'text' ? t('workspace.panel.form.nameText') : t('workspace.panel.form.nameDocx'))}
                value={form.name}
                onChangeText={value => setForm(current => ({ ...current, name: value }))}
              />
              {form.kind === 'folder' ? null : (
                <TextField
                  style={[styles.input, styles.contentInput]}
                  placeholder={t('workspace.panel.form.content')}
                  value={form.content}
                  onChangeText={value => setForm(current => ({ ...current, content: value }))}
                  multiline
                />
              )}
              <View style={styles.formActions}>
                <GhostButton title={t('common.cancel')} small onPress={() => setForm(null)} />
                <PrimaryButton title={t('common.save')} small onPress={submitForm} />
              </View>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>
          ) : null}

          {!loading && files.length === 0 && !error ? (
            <EmptyState
              icon="briefcase-outline"
              title={t('workspace.panel.empty.title')}
              description={canWrite
                ? t('workspace.panel.empty.write')
                : t('workspace.panel.empty.read')}
            />
          ) : null}

          {files.map(name => renderFileRow(name))}
        </ScrollView>

        {storeRef.current ? (
          <TouchableOpacity
            style={styles.chatLauncher}
            onPress={() => setChatOpen(true)}
            activeOpacity={0.85}
            accessibilityLabel={t('workspace.panel.openChat')}
          >
            <Ionicons name="sparkles-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.chatLauncherText} numberOfLines={1}>{t('workspace.panel.openChat')}</Text>
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={theme.colors.textFaint} />
          </TouchableOpacity>
        ) : null}
        <Modal visible={characterPickerOpen} animationType="slide" onRequestClose={() => setCharacterPickerOpen(false)}>
          <View style={styles.container}>
            <SheetHeader title={t('workspace.panel.character.title')} onClose={() => setCharacterPickerOpen(false)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{t('workspace.panel.character.pickerHint')}</FieldHint>
              {pickerCharacters.map(item => (
                <View key={item.id} style={styles.fileRow}>
                  <TouchableOpacity style={styles.fileMain} onPress={() => selectWorkspaceCharacter(item)} activeOpacity={0.8}>
                    <Ionicons name="person-circle-outline" size={18} color={theme.colors.primaryMuted} />
                    <Text style={styles.fileName} numberOfLines={1}>{item.name || item.id}</Text>
                  </TouchableOpacity>
                  {item.id === characterId ? (
                    <Ionicons name="checkmark" size={18} color={theme.colors.primary} />
                  ) : null}
                </View>
              ))}
            </ScrollView>
          </View>
        </Modal>

        <Modal visible={viewerOpen} animationType="slide" onRequestClose={() => setViewerOpen(false)}>
          <View style={styles.container}>
            <SheetHeader title={t('workspace.panel.viewer.title')} onClose={() => setViewerOpen(false)} />
            <View style={styles.viewerTabs}>
              {['files', 'history'].map(tab => {
                const active = viewerTab === tab;
                return (
                  <TouchableOpacity
                    key={tab}
                    style={[styles.viewerTab, active && styles.viewerTabActive]}
                    onPress={() => openViewer(tab)}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.viewerTabText, active && styles.viewerTabTextActive]}>
                      {t(tab === 'files' ? 'workspace.panel.viewer.tab.files' : 'workspace.panel.viewer.tab.history')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <ScrollView contentContainerStyle={styles.body}>
              {viewerTab === 'files' ? (
                files.length === 0 ? (
                  <EmptyState
                    icon="folder-open-outline"
                    title={t('workspace.panel.empty.title')}
                    description={canWrite ? t('workspace.panel.empty.write') : t('workspace.panel.empty.read')}
                  />
                ) : files.map(name => renderFileRow(name))
              ) : (
                <>
                  {changesLoading ? (
                    <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>
                  ) : null}
                  {!changesLoading && changes.length === 0 ? (
                    <EmptyState
                      icon="time-outline"
                      title={t('workspace.panel.viewer.history.empty.title')}
                      description={t('workspace.panel.viewer.history.empty.body')}
                    />
                  ) : null}
                  {!changesLoading && changes.length > 0 ? (
                    <TouchableOpacity style={styles.clearHistoryRow} onPress={clearHistory} activeOpacity={0.8}>
                      <Ionicons name="trash-outline" size={13} color={theme.colors.textMuted} />
                      <Text style={styles.clearHistoryText}>{t('workspace.panel.viewer.clear.action')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {changes.map(entry => {
                    const meta = CHANGE_OP_META[entry.op] || CHANGE_OP_META.write;
                    const expanded = expandedChangeId === entry.id;
                    return (
                      <View key={entry.id} style={styles.changeCard}>
                        <TouchableOpacity
                          style={styles.changeMain}
                          onPress={() => setExpandedChangeId(expanded ? '' : entry.id)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name={meta.icon} size={15} color={theme.colors.primaryMuted} />
                          <View style={styles.changeText}>
                            <Text style={styles.changeTitle} numberOfLines={1}>
                              {t(meta.labelKey)}{' '}{entry.path}
                            </Text>
                            <Text style={styles.changeMeta} numberOfLines={1}>
                              {formatChangeTime(entry.at)}
                              {entry.op === 'write' ? ` · ${t('workspace.panel.history.chars', { count: entry.length })}` : ''}
                              {entry.op === 'write' && entry.created ? ` · ${t('workspace.panel.history.created')}` : ''}
                              {entry.op === 'edit' ? ` · ${t('workspace.panel.history.replaced', { count: entry.count })}${entry.all ? `（${t('workspace.panel.history.all')}）` : ''}` : ''}
                              {entry.op === 'delete' ? ` · ${t('workspace.panel.history.deleted')}` : ''}
                            </Text>
                          </View>
                          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textFaint} />
                        </TouchableOpacity>
                        {expanded && entry.op === 'edit' ? (
                          <View style={styles.changeDetail}>
                            <Text style={styles.changeDetailLabel}>{t('workspace.panel.history.find')}</Text>
                            <Text style={styles.changeDetailText}>{entry.find}</Text>
                            <Text style={styles.changeDetailLabel}>{t('workspace.panel.history.replace')}</Text>
                            <Text style={styles.changeDetailText}>{entry.replace}</Text>
                          </View>
                        ) : null}
                        {expanded && entry.op !== 'edit' ? (
                          <View style={styles.changeDetail}>
                            <Text style={styles.changeDetailText}>
                              {entry.op === 'delete'
                                ? t('workspace.panel.history.deleted')
                                : t('workspace.panel.history.detail.write', { chars: entry.length })}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </>
              )}
            </ScrollView>
          </View>
        </Modal>

        <Modal visible={catalogOpen} animationType="slide" onRequestClose={() => setCatalogOpen(false)}>
          <View style={styles.container}>
            <SheetHeader title={t('workspace.panel.catalog.title')} onClose={() => setCatalogOpen(false)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{t('workspace.panel.catalog.hint')}</FieldHint>
              {CATALOG_CATEGORIES.map(category => {
                const items = catalogItemsByCategory(category);
                if (items.length === 0) return null;
                return (
                  <View key={category} style={styles.catalogSection}>
                    <FieldLabel>{t(`workspace.panel.catalog.category.${category}`)}</FieldLabel>
                    {items.map(item => {
                      const inputs = item.inputs || [];
                      const busy = catalogBusyId === item.id;
                      return (
                        <View key={item.id} style={styles.catalogItem}>
                          <View style={styles.catalogItemMain}>
                            <Text style={styles.catalogItemTitle} numberOfLines={1}>{t(item.titleKey)}</Text>
                            <TouchableOpacity
                              style={[styles.catalogWriteButton, busy && styles.actionButtonDisabled]}
                              disabled={!!catalogBusyId}
                              onPress={() => handleCatalogWrite(item.id)}
                              activeOpacity={0.85}
                            >
                              <Text style={styles.catalogWriteText}>{t('workspace.panel.catalog.write')}</Text>
                            </TouchableOpacity>
                          </View>
                          <Text style={styles.catalogItemDesc}>{t(item.descKey)}</Text>
                          <Text style={styles.catalogItemFile}>{item.file}</Text>
                          {inputs.length > 0 ? (
                            <View style={styles.catalogInputs}>
                              {inputs.map(input => (
                                <TextField
                                  key={input.key}
                                  style={styles.input}
                                  label={t(input.labelKey)}
                                  placeholder={t(input.placeholderKey)}
                                  value={(catalogInputs[item.id] && catalogInputs[item.id][input.key]) || ''}
                                  onChangeText={value => setCatalogInputs(current => ({
                                    ...current,
                                    [item.id]: { ...(current[item.id] || {}), [input.key]: value },
                                  }))}
                                />
                              ))}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                );
              })}

              <View style={styles.catalogSection}>
                <FieldLabel>{t('workspace.panel.catalog.custom.title')}</FieldLabel>
                <TextField
                  style={styles.input}
                  placeholder={t('workspace.panel.catalog.custom.placeholder')}
                  value={customUrl}
                  onChangeText={setCustomUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <View style={styles.formActions}>
                  <PrimaryButton
                    title={customBusy ? t('workspace.panel.catalog.custom.busy') : t('workspace.panel.catalog.custom.action')}
                    small
                    onPress={handleCustomDownload}
                  />
                </View>
                <FieldHint>{t('workspace.panel.catalog.custom.hint')}</FieldHint>
              </View>
            </ScrollView>
          </View>
        </Modal>

        <Modal visible={!!preview} animationType="slide" onRequestClose={() => setPreview(null)}>
          <View style={styles.container}>
            <SheetHeader title={preview ? preview.path : ''} onClose={() => setPreview(null)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{preview && preview.truncated ? t('workspace.panel.preview.truncated') : t('workspace.panel.preview.hint')}</FieldHint>
              <Text style={styles.previewText}>{preview ? preview.content : ''}</Text>
              <View style={styles.formActions}>
                <GhostButton
                  title={t('common.copy')}
                  small
                  onPress={() => {
                    if (preview) Clipboard.setStringAsync(preview.content).catch(() => {});
                  }}
                />
                <GhostButton title={t('workspace.panel.a11y.share', { name: preview ? preview.path : '' })} small onPress={() => { if (preview) shareFile(preview.path); }} />
              </View>
            </ScrollView>
          </View>
        </Modal>

        <WorkspaceChat
          visible={chatOpen}
          onClose={() => setChatOpen(false)}
          characterId={characterId}
          mode={mode}
          settings={settingsRef.current}
          characterName={characterName}
          onFilesChanged={refresh}
        />
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  chatLauncher: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md || tokens.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    borderColor: theme.colors.surfaceBorder,
    borderWidth: tokens.border.thin,
  },
  chatLauncherText: { flex: 1, color: theme.colors.primary, fontSize: fonts.scaled(13.5), textAlign: 'center' },
  modeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  modeText: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 6, flex: 1 },
  sandboxHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 12 },
  characterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  characterAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  characterAvatarImage: { width: '100%', height: '100%' },
  characterAvatarText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  characterText: { flex: 1, marginLeft: 10, marginRight: 8 },
  characterName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  characterHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), lineHeight: fonts.scaled(14), marginTop: 2 },
  characterSelectButton: {
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  characterSelectText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600' },
  controlCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  thinkingChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  thinkingChip: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 6,
  },
  thinkingChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  thinkingChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  thinkingChipTextActive: { color: theme.colors.primaryContrast },
  contextBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.divider,
    overflow: 'hidden',
    marginTop: 6,
    marginBottom: 6,
  },
  contextFill: { height: '100%', borderRadius: 3, backgroundColor: theme.colors.primary },
  contextFillWarn: { backgroundColor: theme.colors.danger || theme.colors.primary },
  contextText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12) },
  viewerTabs: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginBottom: 4,
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    padding: 3,
  },
  viewerTab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: tokens.radius.sm },
  viewerTabActive: { backgroundColor: theme.colors.primary },
  viewerTabText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), fontWeight: '600' },
  viewerTabTextActive: { color: theme.colors.primaryContrast },
  clearHistoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginBottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  clearHistoryText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 4 },
  changeCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 8,
    overflow: 'hidden',
  },
  changeMain: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  changeText: { flex: 1, marginLeft: 8, marginRight: 8 },
  changeTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  changeMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), marginTop: 3 },
  changeDetail: {
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  changeDetailLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(10), fontWeight: '700', marginTop: 4 },
  changeDetailText: { color: theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17), marginTop: 2 },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), marginBottom: 10 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 10,
  },
  actionButtonDisabled: { opacity: 0.5 },
  catalogSection: { marginBottom: 16 },
  catalogItem: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginBottom: 10,
  },
  catalogItemMain: { flexDirection: 'row', alignItems: 'center' },
  catalogItemTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', flex: 1, marginRight: 8 },
  catalogItemDesc: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  catalogItemFile: { color: theme.colors.primary, fontSize: fonts.scaled(11), marginTop: 4 },
  catalogWriteButton: {
    borderRadius: tokens.metrics.buttonRadius,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  catalogWriteText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(12), fontWeight: '600' },
  catalogInputs: { marginTop: 8 },
  actionText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 5 },
  formCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.metrics.cardPadding,
    marginBottom: 12,
  },
  input: { marginTop: 8 },
  contentInput: { minHeight: 120, textAlignVertical: 'top' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fileMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  fileName: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 8, flex: 1 },
  fileAction: { paddingHorizontal: 6, paddingVertical: 4 },
  previewText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20), marginTop: 8 },
});