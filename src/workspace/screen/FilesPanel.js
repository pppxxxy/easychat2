// 工作区面板：浏览当前「工作区角色」沙盒内的文本/Markdown 与导出的 .docx。
// - 文本文件：预览、复制、分享、删除；可改模式：新建文本、导出一段文本为 Word（.docx）；
// - 工作区角色：面板顶部选择（默认落到「EasyChat2 工作助手」，不存在时自动建卡），文件按角色
//   分沙盒，与该角色在聊天里用工具读写的是同一个目录；入口在「设置 → 工作区」。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';

import { EmptyState, FieldHint, FieldLabel, GhostButton, PrimaryButton, SheetHeader, TextField } from '../../ui/index.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { useApp } from '../../context/AppContext.js';
import {
  clearWorkspaceChanges,
  getWorkspaceChanges,
  getWorkspaceSettings,
  patchWorkspaceSettings,
} from '../../storage/workspace.js';
import { getCharacterLibrary } from '../../storage/characters.js';
import { resolveWorkspaceAssistant } from '../assistant.js';
import { buildDocxBytes, bytesToBase64, splitDocxParagraphs } from '../docx.js';
import { createWorkspaceStore, describeWorkspaceRoot } from '../native.js';
import { isAllowedWorkspaceFile, isAllowedWorkspaceOutputFile } from '../paths.js';
import { isRichPreview } from '../filePreview.js';
import AssistantMessageBody from '../../chat/AssistantMessageBody.js';
import { ensureDocxFileName, ensureDirectoryName, ensureTextFileName, isDocxName, sanitizeWorkspaceFileName } from '../naming.js';
import { WORKSPACE_ROOT_KINDS } from '../location.js';
import { CATALOG_ITEMS, buildCatalogContent, findCatalogBundle, findCatalogItem } from '../catalog.js';
import { breadcrumbsOf, directoryChildren, groupWorkspaceFiles, parentDirectoryOf } from './buildTree.js';
import { searchWorkspaceFiles } from '../fileSearch.js';
import ConfirmBar from './ConfirmBar.js';
import CatalogSheet from './files/CatalogSheet.js';
import FileHistorySheet from '../FileHistorySheet.js';
import { isTextLike, pickAttachment, readTextAttachment } from '../../chat/attachments.js';
import createStyles from './filesPanelStyles.js';

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
  import: { icon: 'cloud-download-outline', labelKey: 'workspace.panel.history.op.import' },
};

export default function FilesPanel({ visible, characterId: initialCharacterId = 'default', initialSection = '', onOpenHistory = null }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const { refreshAppData } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [mode, setMode] = useState('ask');
  // 根可能被用户在设置里改（应用内默认 ↔ 外部文件夹），故随设置变化而不是一次算死。
  const [root, setRoot] = useState(() => describeWorkspaceRoot(null));
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  // 预览面板：Markdown/HTML 默认渲染，可切「查看原文」（源码、调试时用）。
  const [previewRaw, setPreviewRaw] = useState(false);
  // J1 二期：文件历史面板的开关与目标路径（路径为空 = 看总览）。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState('');
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
  // 文件区当前所在目录（'' = 根层，按项目分组）。进入项目/目录后逐层下钻，
  // 路径只在面包屑里出现，不再把「repos/x/main/src/…」整条挤在文件行里被截断（诉求④）。
  const [subdir, setSubdir] = useState('');
  // P2-3：文件搜索（**跨目录**——逐层下钻时找已知名字的文件只能靠记忆点进去）。
  // 空查询时照旧显示目录树，不显示「全部文件」的平铺。
  const [fileQuery, setFileQuery] = useState('');
  // D1：把文本文件导入**当前浏览的目录**（根层沿用 imports/ 旧落点）——技能生态
  // 的关键通路：在 .easychat/skills/<名字>/ 里点「导入文件」即建技能资源文件。
  const [fileImportBusy, setFileImportBusy] = useState(false);
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [expandedChangeId, setExpandedChangeId] = useState('');
  // 环境与配置下载：目录弹层、需输入的模板表单（.gitconfig 的提交身份）、自定义 URL。
  const [catalogOpen, setCatalogOpen] = useState(false);
  // 套餐：写入进度 {id, done, total}；条目状态 'absent' | 'same' | 'diff'（弹层打开时比对）。
  const [bundleBusy, setBundleBusy] = useState(null);
  const [catalogStatuses, setCatalogStatuses] = useState({});
  const [catalogInputs, setCatalogInputs] = useState({});
  const [catalogBusyId, setCatalogBusyId] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customBusy, setCustomBusy] = useState(false);
  // 打开面板那一刻的后端。中途用户在设置里改根时，面板内的操作仍按打开时的根走，
  // 避免「列出来的是 A 文件夹的文件、删的却是 B 文件夹」。
  const storeRef = useRef(null);
  // 指令对话框登记工具时需要完整设置快照（模式/根/命令执行开关），随面板一起冻结。
  const settingsRef = useRef(null);
  const mountedRef = useRef(true);

  const canWrite = mode === 'write';
  const external = root.kind === WORKSPACE_ROOT_KINDS.SAF;

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
        refresh(resolved.id || undefined);
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(t('workspace.panel.err.read'));
      }
    })();
  }, [visible, refresh, t, refreshAppData]);

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
      if (mountedRef.current) {
        setPreviewRaw(false);
        setPreview(result);
      }
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.open'), t('workspace.panel.err.open'));
    }
  }, [characterId, shareFile, t]);

  // P4-4：删除改成**面板内确认条**（此前是系统弹框——它盖住的是整个工作区，用户还得先读完
  // 两行字才知道删的是哪个文件）。这里只记下「在等哪一次确认」，真正的删除在 confirmDelete。
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingClear, setPendingClear] = useState(false);
  const [pendingDirDelete, setPendingDirDelete] = useState(null);

  const handleDelete = useCallback(name => {
    setPendingDelete({ name });
  }, []);

  const confirmDelete = useCallback(() => {
    const target = pendingDelete && pendingDelete.name;
    setPendingDelete(null);
    const store = storeRef.current;
    if (!target || !store) return;
    store.deleteFile({ characterId, path: target })
      .then(() => {
        if (!mountedRef.current) return;
        setFiles(list => list.filter(entry => entry !== target));
        if (preview && preview.path === target) setPreview(null);
      })
      .catch(() => Alert.alert(t('workspace.panel.err.delete'), t('workspace.panel.err.delete')));
  }, [characterId, pendingDelete, preview, t]);

  // F2：目录删除——只允许删**空目录**（删前用当前文件清单再确认一次；
  // store 层还有第二道校验）。空目录多为导入残留（旧格式 / 上次没跑完），
  // 能删掉它，用户才不会走进「黑房间」。
  const handleDeleteDirectory = useCallback(path => {
    if (directoryChildren(files, path).length > 0) {
      Alert.alert(
        t('workspace.panel.delete.dirNonEmpty.title'),
        t('workspace.panel.delete.dirNonEmpty.body')
      );
      return;
    }
    const store = storeRef.current;
    if (!store || typeof store.deleteWorkspaceDirectory !== 'function') {
      Alert.alert(t('workspace.panel.err.delete'), t('workspace.panel.err.delete'));
      return;
    }
    const label = String(path).split('/').filter(Boolean).slice(-1)[0] || String(path);
    // P4-4：删除确认改用面板内确认条（与删除文件、清空改动同一形状）。
    // 上面「非空目录」那处**保持系统 Alert**——那是「用户没预期的拒绝」，属于必须打断的场景。
    setPendingDirDelete({ path, label });
  }, [characterId, files, t]);

  const confirmDirDelete = useCallback(() => {
    const target = pendingDirDelete && pendingDirDelete.path;
    setPendingDirDelete(null);
    const store = storeRef.current;
    if (!target || !store || typeof store.deleteWorkspaceDirectory !== 'function') return;
    store.deleteWorkspaceDirectory({ characterId, path: target })
      .then(() => {
        if (!mountedRef.current) return;
        setFiles(list => list.filter(entry => entry !== target));
      })
      .catch(() => Alert.alert(t('workspace.panel.err.delete'), t('workspace.panel.err.delete')));
  }, [characterId, pendingDirDelete, t]);

  // D1：导入文本文件到**当前浏览的目录**（根层沿用 imports/ 旧落点）——技能生态的
  // 关键通路：在 .easychat/skills/<名字>/ 里导入即建资源文件（scripts、templates）。
  const handleImportToCurrentDir = useCallback(async () => {
    if (!canWrite) {
      Alert.alert(t('workspace.panel.locked.title'), t('workspace.panel.locked.body'));
      return;
    }
    if (fileImportBusy) return;
    const store = storeRef.current;
    if (!store) return;
    setFileImportBusy(true);
    try {
      const asset = await pickAttachment();
      if (!asset) return;
      if (!isTextLike(asset.name, asset.mime)) {
        Alert.alert(t('workspace.settings.import.errTitle'), t('workspace.settings.import.errBody'));
        return;
      }
      const text = await readTextAttachment(asset.uri);
      const name = String(asset.name || '').split('/').pop() || 'imported.txt';
      const target = subdir ? `${subdir}${name}` : `imports/${name}`;
      await store.writeWorkspaceFile({ characterId, path: target, content: text });
      await refresh();
      Alert.alert(
        t('workspace.settings.import.doneTitle'),
        t('workspace.settings.import.done', { name: target })
      );
    } catch (caught) {
      Alert.alert(
        t('workspace.settings.import.errTitle'),
        (caught && caught.message) || t('workspace.settings.import.errBody')
      );
    } finally {
      if (mountedRef.current) setFileImportBusy(false);
    }
  }, [canWrite, characterId, fileImportBusy, refresh, subdir, t]);

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

  // P4-4：清空改动也走面板内确认条（此前是系统弹框）。只记下「在等哪一次确认」。
  const clearHistory = useCallback(() => {
    setPendingClear(true);
  }, []);

  const confirmClear = useCallback(() => {
    setPendingClear(false);
    clearWorkspaceChanges(characterId)
      .then(() => { if (mountedRef.current) setChanges([]); })
      .catch(() => {});
  }, [characterId]);

  // —— 环境与配置下载 ——
  // 写入走 store.writeWorkspaceFile：与面板手写同一条路径，自动进历史改动。
  // quiet 变体供套餐逐条调用（不逐条弹框，整组结束统一报告；失败向上抛）。
  const writeCatalogFileQuiet = useCallback(async (path, content) => {
    const store = storeRef.current;
    if (!store) throw new Error('workspace store unavailable');
    await store.writeWorkspaceFile({ characterId, path, content });
    if (mountedRef.current) await refresh();
  }, [characterId, refresh]);

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
      setCatalogStatuses(current => ({ ...current, [itemId]: 'same' }));
    } finally {
      if (mountedRef.current) setCatalogBusyId('');
    }
  }, [catalogBusyId, catalogInputs, writeCatalogFile]);

  // 弹层打开时比对每条状态：沙盒没有 → absent；有且内容一致 → same；有但不同 → diff。
  // 只比内容字符串相等，不做 diff UI。gitconfig 内容随输入变化，以当前输入为准。
  const loadCatalogStatuses = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    const next = {};
    for (const item of CATALOG_ITEMS) {
      try {
        if (!files.includes(item.file)) {
          next[item.id] = 'absent';
          continue;
        }
        const result = await store.readWorkspaceFile({ characterId, path: item.file });
        const expected = buildCatalogContent(item, catalogInputs[item.id] || {});
        next[item.id] = String(result && result.content) === expected ? 'same' : 'diff';
      } catch (error) {
        next[item.id] = 'absent';
      }
    }
    if (mountedRef.current) setCatalogStatuses(next);
  }, [catalogInputs, characterId, files]);

  useEffect(() => {
    if (catalogOpen) loadCatalogStatuses();
  }, [catalogOpen, loadCatalogStatuses]);

  // 一键套餐：逐条走单条写入路径（自动进历史改动）；单条失败不中断，结束统一报告。
  const handleBundleWrite = useCallback(async bundleId => {
    const bundle = findCatalogBundle(bundleId);
    if (!bundle || bundleBusy || catalogBusyId) return;
    setBundleBusy({ id: bundleId, done: 0, total: bundle.items.length });
    const failures = [];
    const written = [];
    const gitIdentity = bundle.needsGitIdentity ? (catalogInputs.gitconfig || {}) : {};
    try {
      for (let index = 0; index < bundle.items.length; index += 1) {
        const item = findCatalogItem(bundle.items[index]);
        if (item) {
          try {
            const content = buildCatalogContent(item, item.id === 'gitconfig' ? gitIdentity : {});
            await writeCatalogFileQuiet(item.file, content);
            written.push(item.file);
          } catch (error) {
            failures.push(item.file);
          }
        }
        if (mountedRef.current) setBundleBusy({ id: bundleId, done: index + 1, total: bundle.items.length });
      }
    } finally {
      if (mountedRef.current) setBundleBusy(null);
    }
    await refresh();
    if (mountedRef.current) loadCatalogStatuses();
    if (mountedRef.current) {
      const summary = `${t('workspace.panel.catalog.bundle.donePrefix', { count: written.length })}\n${written.join('\n')}`;
      const failureNote = failures.length > 0
        ? `\n\n${t('workspace.panel.catalog.bundle.failures', { list: failures.join('\n') })}`
        : '';
      Alert.alert(t('workspace.panel.catalog.bundle.doneTitle'), summary + failureNote);
    }
  }, [bundleBusy, catalogBusyId, catalogInputs, loadCatalogStatuses, refresh, t, writeCatalogFileQuiet]);

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

  // —— 文件区分组与下钻（诉求④）——
  // 根层：工作区自己的散文件 + 每个导入项目一张卡；进入项目/目录后逐层列出直接子项。
  // 路径只在面包屑里出现，不再把 repos/x/main/src/… 整条挤进文件行被截断。
  const { rootEntries, groups } = useMemo(() => groupWorkspaceFiles(files), [files]);
  const children = useMemo(() => directoryChildren(files, subdir), [files, subdir]);
  // P2-3：命中结果与总数（界面要说「还有 N 条未显示」，所以不能只拿截断后的数组）。
  const fileSearch = useMemo(() => searchWorkspaceFiles(files, fileQuery), [files, fileQuery]);
  const crumbs = useMemo(
    () => breadcrumbsOf(subdir, t('workspace.panel.breadcrumb.root')),
    [subdir, t]
  );
  // 当前目录被删空（或换了角色/根）时退回根层，避免停在空目录里。
  useEffect(() => {
    if (!subdir) return;
    if (!files.some(entry => String(entry).startsWith(subdir))) setSubdir('');
  }, [files, subdir]);

  const renderEntryRow = entry => (
    <View key={entry.path} style={styles.fileRow}>
      <TouchableOpacity
        style={styles.fileMain}
        onPress={() => (entry.isDirectory ? setSubdir(entry.path) : openFile(entry.path))}
        activeOpacity={0.8}
      >
        <Ionicons
          name={entry.isDirectory ? 'folder-outline' : (isDocxName(entry.path) ? 'document-outline' : 'document-text-outline')}
          size={16}
          color={theme.colors.primaryMuted}
        />
        <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{entry.name}</Text>
      </TouchableOpacity>
      {entry.isDirectory ? (
        // F2：空目录可删（非空点击给提示，图标略淡提示不可用）——空目录正是
        // 「导入残留 / 旧格式」的典型形态；能删掉它，误导就不会留下来
        //（以前目录行没有删除入口，空目录永远删不掉，只能干看）。
        <TouchableOpacity
          style={styles.fileAction}
          onPress={() => handleDeleteDirectory(entry.path)}
          accessibilityLabel={t('workspace.panel.a11y.delete', { name: entry.name })}
        >
          <Ionicons
            name="trash-outline"
            size={16}
            color={directoryChildren(files, entry.path).length === 0
              ? theme.colors.textMuted
              : theme.colors.textFaint}
          />
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity
            style={styles.fileAction}
            onPress={() => shareFile(entry.path)}
            accessibilityLabel={t('workspace.panel.a11y.share', { name: entry.name })}
          >
            <Ionicons name="share-outline" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.fileAction}
            onPress={() => handleDelete(entry.path)}
            accessibilityLabel={t('workspace.panel.a11y.delete', { name: entry.name })}
          >
            <Ionicons name="trash-outline" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  const renderProjectCard = group => (
    <TouchableOpacity
      key={group.id}
      style={styles.projectCard}
      onPress={() => setSubdir(group.prefix)}
      activeOpacity={0.85}
    >
      <Ionicons
        name="logo-github"
        size={18}
        color={theme.colors.primaryMuted}
      />
      <View style={styles.projectMain}>
        <Text style={styles.projectName} numberOfLines={1} ellipsizeMode="middle">{group.label}</Text>
        <Text style={styles.projectMeta} numberOfLines={1}>
          {group.prefix}
          {' · '}
          {/* F3：路径前缀展示 + 空组明确标注——旧格式残留（repos/x/y/ 被解析成
              「owner=x、repo=y」）与真项目卡长得一样，前缀能让用户一眼分辨；
              空组直接说穿，不让它伪装成「有内容的仓库」。 */}
          {group.fileCount + group.dirCount === 0
            ? t('workspace.panel.group.empty')
            : t('workspace.panel.group.files', { count: group.fileCount + group.dirCount })}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.colors.textFaint} />
    </TouchableOpacity>
  );

  // P2-3：搜索结果（平铺、跨目录）。每行带出所在目录——搜索的意义就是「不用知道在哪」，
  // 但看到结果得知道它在哪儿，否则点开前没有判断依据。
  const renderSearchResults = () => {
    if (fileSearch.matches.length === 0) {
      return (
        <EmptyState
          icon="search-outline"
          title={t('workspace.panel.search.empty')}
          description={t('workspace.panel.search.emptyHint', { query: fileQuery.trim() })}
        />
      );
    }
    return (
      <>
        {fileSearch.matches.map(item => (
          <TouchableOpacity
            key={item.path}
            style={styles.fileRow}
            onPress={() => openFile(item.path)}
            activeOpacity={0.8}
          >
            <View style={styles.fileMain}>
              <Ionicons
                name={isDocxName(item.path) ? 'document-outline' : 'document-text-outline'}
                size={16}
                color={theme.colors.primaryMuted}
              />
              <View style={styles.searchTextBlock}>
                <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{item.name}</Text>
                {item.dir ? (
                  <Text style={styles.searchDir} numberOfLines={1} ellipsizeMode="middle">{item.dir}</Text>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        ))}
        {/* 截断了就说清楚还有多少——静默截断会让用户以为「就这些」。 */}
        {fileSearch.truncated ? (
          <Text style={styles.searchMore}>
            {t('workspace.panel.search.more', { count: fileSearch.total - fileSearch.matches.length })}
          </Text>
        ) : null}
      </>
    );
  };

  const renderFileBrowser = () => {
    if (loading) return <View style={styles.center}><ActivityIndicator color={theme.colors.primary} /></View>;
    if (error) return null;
    if (files.length === 0) {
      return (
        <EmptyState
          icon="briefcase-outline"
          title={t('workspace.panel.empty.title')}
          description={canWrite ? t('workspace.panel.empty.write') : t('workspace.panel.empty.read')}
        />
      );
    }
    // P2-3：有搜索词就用平铺结果替代目录树（搜索的价值就在跨目录）。
    if (fileQuery.trim()) return renderSearchResults();
    if (subdir) {
      return (
        <>
          <View style={styles.crumbRow}>
            {crumbs.map((crumb, index) => (
              <View key={crumb.path || 'root'} style={styles.crumbItem}>
                {index > 0 ? <Ionicons name="chevron-forward" size={12} color={theme.colors.textFaint} /> : null}
                <TouchableOpacity onPress={() => setSubdir(crumb.path)} activeOpacity={0.7}>
                  <Text
                    style={[styles.crumbText, index === crumbs.length - 1 && styles.crumbTextActive]}
                    numberOfLines={1}
                  >
                    {crumb.name}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
          {children.length > 0 ? children.map(renderEntryRow) : (
            // F1：子目录为空时给出空状态与返回入口——以前点进空目录（导入残留 /
            // 旧格式目录）是一片无语义的空白，用户会以为文件丢了。
            <EmptyState
              icon="folder-open-outline"
              title={t('workspace.panel.empty.dir.title')}
              description={t('workspace.panel.empty.dir.body')}
              action={(
                <GhostButton
                  title={t('workspace.panel.empty.dir.back')}
                  small
                  onPress={() => setSubdir(parentDirectoryOf(subdir))}
                />
              )}
            />
          )}
        </>
      );
    }
    return (
      <>
        {rootEntries.length > 0 ? (
          <>
            <FieldLabel>{t('workspace.panel.group.workspace')}</FieldLabel>
            {directoryChildren(rootEntries, '').map(renderEntryRow)}
          </>
        ) : null}
        {groups.length > 0 ? (
          <>
            <FieldLabel>{t('workspace.panel.group.projects')}</FieldLabel>
            {groups.map(renderProjectCard)}
          </>
        ) : null}
      </>
    );
  };

  // 查看文件（已创建的文件 / 历史改动）：面板**内部**的层（v2 §3：面板内二级层深度 ≤ 2）。
  const renderViewerBody = () => (
    <>
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
      {viewerTab === 'files' ? renderFileBrowser() : (
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
                      {entry.op === 'import' ? ` · ${t('workspace.panel.history.imported', { count: entry.count })}` : ''}
                    </Text>
                  </View>
                  <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textFaint} />
                </TouchableOpacity>
                {expanded && entry.op === 'edit' ? (
                  <View style={styles.changeDetail}>
                    <Text style={styles.changeDetailLabel}>{t('workspace.panel.history.find')}</Text>
                    <Text style={styles.changeDetailText} selectable>{entry.find}</Text>
                    <Text style={styles.changeDetailLabel}>{t('workspace.panel.history.replace')}</Text>
                    <Text style={styles.changeDetailText} selectable>{entry.replace}</Text>
                  </View>
                ) : null}
                {expanded && entry.op !== 'edit' ? (
                  <View style={styles.changeDetail}>
                    <Text style={styles.changeDetailText} selectable>
                      {entry.op === 'delete'
                        ? t('workspace.panel.history.deleted')
                        : entry.op === 'import'
                          ? t('workspace.panel.history.detail.import', { count: entry.count, path: entry.path })
                          : t('workspace.panel.history.detail.write', { chars: entry.length })}
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </>
      )}
    </>
  );

  // P4-4：破坏性操作的面板内确认条（删除文件 / 清空改动 / 删除空目录）。**必须**与浏览区
  // 平级：viewer 二级层的文件页签渲染的就是同一个 renderFileBrowser（清空改动更只在历史页签），
  // 塞进 `viewerOpen ? … : (…)` 的 else 分支会让 viewer 内点删除毫无反应、状态却已置位。
  // 三条确认条共用的外壳 props：抽出来是为了让本文件的净行数不涨（行数棘轮只许收紧），
  // 顺手也去掉三处逐字重复。
  const confirmBarChrome = { confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), theme, fonts, tokens };
  const renderConfirmBars = () => (
    <>
      {pendingDelete ? (
        <ConfirmBar
          title={t('workspace.panel.delete.title')}
          body={t('workspace.panel.delete.body', { name: pendingDelete.name })}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
          {...confirmBarChrome}
        />
      ) : null}
      {pendingClear ? (
        <ConfirmBar
          title={t('workspace.panel.viewer.clear.title')}
          body={t('workspace.panel.viewer.clear.body')}
          onConfirm={confirmClear}
          onCancel={() => setPendingClear(false)}
          {...confirmBarChrome}
        />
      ) : null}
      {pendingDirDelete ? (
        <ConfirmBar
          title={t('workspace.panel.delete.dirTitle')}
          body={t('workspace.panel.delete.dirBody', { name: pendingDirDelete.label })}
          onConfirm={confirmDirDelete}
          onCancel={() => setPendingDirDelete(null)}
          {...confirmBarChrome}
        />
      ) : null}
    </>
  );

  // 文件面板（工作区单屏内的「文件」领域）：不自套 Modal、不自带顶栏——那是单屏的职责。
  // 面板内二级层是铺满面板的 View（styles.layer）：全局唯一 Modal 在 WorkspaceScreen（守卫钉着）。
  return (
    <View style={styles.root}>
      <View style={styles.container}>

        <ScrollView contentContainerStyle={styles.body}>
          {viewerOpen ? renderViewerBody() : (
          <>
          <View style={styles.statusBar}>
            <View style={styles.modeBadge}>
              <Text style={styles.modeBadgeText} numberOfLines={1}>{modeLabel}</Text>
            </View>
            <Text style={styles.statusBarText} numberOfLines={1}>
              {external
                ? (root.name || t('settings.workspace.folder.custom'))
                : t('workspace.panel.sandbox', { name: characterLabel })}
            </Text>
            <TouchableOpacity style={styles.statusBarCharacter} onPress={openCharacterPicker} activeOpacity={0.85}>
              <Text style={styles.statusBarCharacterText} numberOfLines={1}>{characterLabel}</Text>
              <Ionicons name="chevron-forward" size={13} color={theme.colors.textFaint} />
            </TouchableOpacity>
          </View>
          {external ? (
            <Text style={styles.sandboxHint} numberOfLines={2}>{t('workspace.panel.sandbox.externalHint')}</Text>
          ) : null}

          <View style={styles.importRow}>
            <TouchableOpacity style={styles.importButton} onPress={() => setCatalogOpen(true)} activeOpacity={0.85}>
              <Ionicons name="download-outline" size={15} color={theme.colors.primaryContrast} />
              <Text style={styles.importButtonText}>{t('workspace.panel.catalog.entry')}</Text>
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.fileToolsRow}>
            <TouchableOpacity
              style={[styles.fileToolButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startTextForm}
              activeOpacity={0.85}
            >
              <Ionicons name="document-text-outline" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.fileToolText}>{t('workspace.panel.newText')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.fileToolButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startFolderForm}
              activeOpacity={0.85}
            >
              <Ionicons name="folder-outline" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.fileToolText}>{t('workspace.panel.newFolder')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.fileToolButton, !canWrite && styles.actionButtonDisabled]}
              onPress={handleImportToCurrentDir}
              activeOpacity={0.85}
            >
              <Ionicons name="cloud-upload-outline" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.fileToolText}>
                {fileImportBusy ? t('workspace.panel.importingFile') : t('workspace.panel.importFile')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.fileToolButton, !canWrite && styles.actionButtonDisabled]}
              onPress={startDocxForm}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.fileToolText}>{t('workspace.panel.exportWord')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.fileToolGhost}
              onPress={() => openViewer('files')}
              activeOpacity={0.85}
            >
              <Ionicons name="folder-open-outline" size={14} color={theme.colors.primary} />
              <Text style={styles.fileToolGhostText}>{t('workspace.panel.viewFiles')}</Text>
            </TouchableOpacity>
            {/* J1 二期：写前快照总览（哪些文件有历史版本）；只读操作，不受模式限制。 */}
            <TouchableOpacity
              style={styles.fileToolGhost}
              onPress={() => { setHistoryPath(''); setHistoryOpen(true); }}
              activeOpacity={0.85}
            >
              <Ionicons name="time-outline" size={14} color={theme.colors.primary} />
              <Text style={styles.fileToolGhostText}>{t('workspace.fileHistory.title')}</Text>
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

          {/* P2-3：文件搜索框。空查询时下方仍是目录树，输入后才切成跨目录的平铺结果。 */}
          {files.length > 0 ? (
            <View style={styles.searchRow}>
              <Ionicons name="search" size={14} color={theme.colors.textFaint} />
              <TextInput
                style={styles.searchInput}
                value={fileQuery}
                onChangeText={setFileQuery}
                placeholder={t('workspace.panel.search.placeholder')}
                placeholderTextColor={theme.colors.textFaint}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
              />
              {fileQuery ? (
                <TouchableOpacity
                  onPress={() => setFileQuery('')}
                  hitSlop={8}
                  accessibilityLabel={t('workspace.panel.search.clear')}
                >
                  <Ionicons name="close-circle" size={15} color={theme.colors.textFaint} />
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {renderFileBrowser()}

          {/* 「调参」折叠卡已删除：思考强度 + 上下文占用在对话面板的 ⚙ 设置里各有一行同款
              可交互控件（同一份数据两处显示必然漂移），且它们是 agent 参数，放在「文件」
              领域本身是范畴错误。收敛到单一来源（P4-2）。 */}
          </>
          )}
        </ScrollView>
        {/* 确认条与浏览区平级：见 renderConfirmBars 的说明。 */}
        {renderConfirmBars()}
      </View>

        {characterPickerOpen ? (
          <View style={styles.layer}>
            <SheetHeader title={t('workspace.panel.character.title')} onClose={() => setCharacterPickerOpen(false)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{t('workspace.panel.character.pickerHint')}</FieldHint>
              {pickerCharacters.map(item => (
                <View key={item.id} style={styles.fileRow}>
                  <TouchableOpacity style={styles.fileMain} onPress={() => selectWorkspaceCharacter(item)} activeOpacity={0.8}>
                    <Ionicons name="person-circle-outline" size={18} color={theme.colors.primaryMuted} />
                    <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{item.name || item.id}</Text>
                  </TouchableOpacity>
                  {item.id === characterId ? (
                    <Ionicons name="checkmark" size={18} color={theme.colors.primary} />
                  ) : null}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <CatalogSheet
          visible={catalogOpen}
          styles={styles}
          t={t}
          onClose={() => setCatalogOpen(false)}
          bundleBusy={bundleBusy}
          catalogBusyId={catalogBusyId}
          catalogStatuses={catalogStatuses}
          catalogInputs={catalogInputs}
          setCatalogInputs={setCatalogInputs}
          customUrl={customUrl}
          setCustomUrl={setCustomUrl}
          customBusy={customBusy}
          onBundleWrite={handleBundleWrite}
          onCatalogWrite={handleCatalogWrite}
          onCustomDownload={handleCustomDownload}
        />

        {preview ? (
          <View style={styles.layer}>
            <SheetHeader title={preview ? preview.path : ''} onClose={() => setPreview(null)} />
            <ScrollView contentContainerStyle={styles.body}>
              <FieldHint>{preview && preview.truncated ? t('workspace.panel.preview.truncated') : t('workspace.panel.preview.hint')}</FieldHint>
              {/* Markdown/HTML 默认按聊天同款渲染；「查看原文」切回纯文本。取色传 theme.colors.text，
                  预览底是 background（深），不能用聊天默认的 bubbleAssistantText（深字）。 */}
              {preview && isRichPreview(preview.path) && !previewRaw ? (
                <AssistantMessageBody text={preview.content} fullWidth textColor={theme.colors.text} />
              ) : (
                /* selectable：文件正文要能长按选中局部文字（整段复制另有按钮，选段靠它）。 */
                <Text style={styles.previewText} selectable>{preview ? preview.content : ''}</Text>
              )}
              <View style={styles.formActions}>
                {preview && isRichPreview(preview.path) ? (
                  <GhostButton
                    title={t(previewRaw ? 'workspace.panel.preview.rendered' : 'workspace.panel.preview.raw')}
                    small
                    onPress={() => setPreviewRaw(value => !value)}
                  />
                ) : null}
                <GhostButton
                  title={t('common.copy')}
                  small
                  onPress={() => {
                    if (preview) Clipboard.setStringAsync(preview.content).catch(() => {});
                  }}
                />
                <GhostButton title={t('workspace.panel.a11y.share', { name: preview ? preview.path : '' })} small onPress={() => { if (preview) shareFile(preview.path); }} />
                {/* J1 二期：写前快照的查看与恢复入口（此前数据层有、UI 够不着）。 */}
                <GhostButton
                  title={t('workspace.fileHistory.title')}
                  small
                  onPress={() => { if (preview) { setHistoryPath(preview.path); setHistoryOpen(true); } }}
                />
              </View>
            </ScrollView>
          </View>
        ) : null}

        <FileHistorySheet
          visible={historyOpen}
          onClose={() => { setHistoryOpen(false); setHistoryPath(''); }}
          onOpenHistory={onOpenHistory}
          store={storeRef.current}
          characterId={characterId}
          path={historyPath}
          onRestored={() => {
            // 恢复改的是文件内容：刷新列表并关掉可能已过期的预览。
            setPreview(null);
            refresh().catch(() => {});
          }}
        />

      </View>
  );
}

