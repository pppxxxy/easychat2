import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
// 新版 File API：它走 JSI（`File.size` 直读文件长度、`FileHandle.readBytes` 走
// RandomAccessFile），**不经过 Java 堆的双份拷贝**，也不再被 Expo 兼容层包掉真实错误。
// 导入大包的分片读就靠它（legacy 的 position/length 只对 Base64 生效，见 backupRead.js）。
import * as NextFileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';

import { exportBackup, importBackup } from './storage/backup.js';
import { validateBackupPayload } from './storage/dataBackup.js';
import { readBackupText } from './storage/backupRead.js';
import { recordDiagnostic } from './storage/diagnostics.js';
// 分阶段错误文案用 tActive 而不是 hook 里的 t：这两个包装函数是模块级的，拿不到 hook。
// 与 storage/backup.js 的 userFacingError 同一口径（那边也用 tActive），
// 且 I18nProvider 会在语言变化时同步活动语言，所以文案会跟随界面语言。
import { tActive } from './i18n/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const PHASE_LABEL_KEYS = {
  storage: 'backup.phase.storage',
  media: 'backup.phase.media',
  packing: 'backup.phase.packing',
  writing: 'backup.phase.writing',
  // 导入侧：分片读取的进度（大包要读好几秒，没有进度用户会以为卡死）。
  reading: 'backup.phase.reading',
};

// 失败/抢救键名在弹窗里的呈现：去掉 @easychat2_ 前缀降低视觉噪音，
// ≤3 个全列，>3 个列前 3 + 「等 N 个」（任务书 P0-1）。键名本身是存储键，
// 不是用户文案，故不经过 t()。
function formatKeyNames(keys, t) {
  const names = (Array.isArray(keys) ? keys : []).map(key => String(key).replace(/^@easychat2_/, ''));
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join('、');
  return t('backup.keysTruncated', { names: names.slice(0, 3).join('、'), count: names.length });
}

// 用户可见错误文案：**我们自己**写的文案（导入校验、包过大、待恢复数据读不出——都在
// storage/dataBackup.js 与 storage/backup.js 里走 tActive，并打了 userFacing 标记）原样透出；
// 其余是内部错误（AsyncStorage 的 checkValidInput 断言、JSON.parse 的 SyntaxError 等英文文案，
// 例如备份包某条只有 key 没有 value ⇒ JSON.stringify(undefined) ⇒ 英文断言），只在开发构建显示。
// 发布构建回落到 backup.alert.*.body 那句正确文案：导入失败时回滚确实保住了数据。
function userMessage(error) {
  const message = String((error && error.message) || '');
  if (!message) return '';
  if (error && error.userFacing) return message;
  return typeof __DEV__ !== 'undefined' && __DEV__ ? message : '';
}

// 把内部错误压成一行短原因，塞进分阶段文案的 {reason}。
// 为什么只取首行 + 截断：JSON.parse 的 SyntaxError、原生 IO 异常会带上整段堆栈/超长消息，
// Alert 里塞不下；而用户真正需要的是「哪一环、什么原因」，细节在诊断日志里。
function shortReason(error) {
  const raw = String((error && error.message) || error || '').split('\n')[0].trim();
  if (!raw) return tActive('common.error.unknown');
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

// 分阶段把导入失败包成 userFacing 错误。
// 为什么必须在**这里**包：发布构建的 userMessage 只透传 userFacing 错误，而
// readAsStringAsync / JSON.parse / importBackup 抛的都是内部错误（英文、无标记），
// 于是全部被吞成「备份文件无法恢复」——用户看不出挂在哪一环（这正是本次要修的）。
// key 为分阶段文案的词条 key；error 是原始错误，会经 shortReason 压成短原因塞进 {reason}，
// 自身也挂在 cause 上便于开发期追溯（诊断日志里已另记完整错误）。
function stageError(key, error) {
  const wrapped = new Error(tActive(key, { reason: shortReason(error) }));
  wrapped.userFacing = true;
  wrapped.cause = error;
  return wrapped;
}

function progressText(progress, t) {
  if (!progress) return t('backup.progress.busy');
  const label = t(PHASE_LABEL_KEYS[progress.phase] || 'backup.phase.busy');
  // 读取阶段：done/total 是**字节数**，用专属文案（带 MB 与总量）。
  // 不复用 writing 那两条——它们是硬写短语、不插值，会把「读取」显示成「打包媒体文件」。
  if (progress.phase === 'reading') {
    const mb = value => (Number(value || 0) / 1024 / 1024).toFixed(1);
    if (progress.total > 0 && progress.total !== progress.done) {
      return t('backup.progress.readingRatio', { done: mb(progress.done), total: mb(progress.total) });
    }
    return progress.done > 0
      ? t('backup.progress.readingDone', { done: mb(progress.done) })
      : t('backup.phase.reading');
  }
  // 写盘阶段的 done/total 也是字节数，按 MB 展示更可读。
  if (progress.phase === 'writing') {
    const mb = value => (Number(value || 0) / 1024 / 1024).toFixed(1);
    if (progress.total > 0 && progress.total !== progress.done) {
      return t('backup.progress.writingRatio', { label, done: mb(progress.done), total: mb(progress.total) });
    }
    return progress.done > 0
      ? t('backup.progress.writingDone', { label, done: mb(progress.done) })
      : t('backup.progress.starting', { label });
  }
  if (progress.total > 0) return t('backup.progress.ratio', { label, done: progress.done, total: progress.total });
  if (progress.done > 0) return t('backup.progress.done', { label, done: progress.done });
  return t('backup.progress.starting', { label });
}

export default function BackupPanel({ visible, onClose, onImported }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [mode, setMode] = useState('full');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const exportControllerRef = useRef(null);

  // 含密钥开关默认关闭；开启前必须明确告知含敏感信息，确认后才生效。
  const toggleSecrets = value => {
    if (!value) {
      setIncludeSecrets(false);
      return;
    }
    Alert.alert(t('backup.secrets.warn.title'), t('backup.secrets.warn.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('backup.secrets.warn.confirm'), onPress: () => setIncludeSecrets(true) },
    ]);
  };

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    const controller = new AbortController();
    exportControllerRef.current = controller;
    try {
      const result = await exportBackup({
        appVersion: '1.0.1',
        signal: controller.signal,
        onProgress: setProgress,
        mode,
        includeSecrets,
      });
      const summary = result.secretsCount > 0
        ? t('backup.summaryWithSecrets', { keys: result.storageCount, media: result.mediaCount, secrets: result.secretsCount, size: (result.bytes / 1024 / 1024).toFixed(2) })
        : t('backup.summary', { keys: result.storageCount, media: result.mediaCount, size: (result.bytes / 1024 / 1024).toFixed(2) });
      // 读不出的键/文件会被跳过，抢救原始数据的键也在其中：必须明确告知，
      // 避免用户拿到“成功”的残缺备份。失败键名直接列出（任务书 P0-1）。
      const unreadableNames = formatKeyNames(result.unreadableKeys, t);
      const partialNames = formatKeyNames(result.partialKeys, t);
      const noteParts = [];
      if (result.incomplete) {
        noteParts.push(t('backup.incompleteNote', {
          keys: result.unreadableKeys.length,
          media: result.unreadableMedia.length,
        }));
        if (unreadableNames) noteParts.push(t('backup.incompleteNote.keys', { names: unreadableNames }));
        if (partialNames) noteParts.push(t('backup.incompleteNote.partial', { names: partialNames }));
      }
      const incompleteNote = noteParts.join('');
      if (await Sharing.isAvailableAsync()) {
        if (result.incomplete) {
          Alert.alert(t('backup.alert.incomplete.title'), t('backup.alert.incomplete.shareBody', { summary, note: incompleteNote }));
        }
        await Sharing.shareAsync(result.uri, { mimeType: 'application/json', dialogTitle: t('backup.shareDialogTitle') });
      } else if (result.incomplete) {
        Alert.alert(t('backup.alert.incomplete.title'), t('backup.alert.incomplete.body', { summary, note: incompleteNote }));
      } else {
        Alert.alert(t('backup.alert.exportDone.title'), t('backup.alert.exportDone.body', { summary }));
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        Alert.alert(t('backup.alert.exportCancelled.title'), t('backup.alert.exportCancelled.body'));
      } else {
        Alert.alert(t('backup.alert.exportFailed.title'), userMessage(error) || t('backup.alert.exportFailed.body'));
      }
    } finally {
      if (exportControllerRef.current === controller) exportControllerRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const cancelExport = () => {
    exportControllerRef.current?.abort();
  };

  const handleImport = async mode => {
    if (busy) return;
    if (mode === 'replace') {
      const confirmed = await new Promise(resolve => {
        Alert.alert(t('backup.alert.confirmReplace.title'), t('backup.alert.confirmReplace.body'), [
          { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('backup.alert.confirmReplace.continue'), style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      // ── 阶段 1：取文件 + 读内容。两者都要给出原因：
      // getDocumentAsync 带 copyToCacheDirectory（会把文件复制到缓存目录，磁盘满/无权限时抛错）；
      // 读取走 backupRead（尺寸预检 + 小文件单发 / 大文件分片），不再是无参数单发整读
      // —— 后者在 Android 上要把整个包读进 Java 堆，83MB 就会 OOM（真机实锤，见 backupRead.js 头注）。
      let raw;
      try {
        const picked = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
        // 取消不是错误：正常返回，不弹任何提示（放在 try 内也不会被 catch 命中）。
        if (picked.canceled || !picked.assets?.[0]?.uri) return;
        const read = await readBackupText({
          uri: picked.assets[0].uri,
          legacyFs: FileSystem,
          nextFs: NextFileSystem,
          onProgress: progress => setProgress({ phase: 'reading', done: progress.bytes, total: progress.total }),
        });
        raw = read.text;
        setProgress(null);
      } catch (error) {
        // backupRead 抛的已经是 userFacing 的用户文案（文件不存在/超限/读取失败），直接透出。
        if (!(error && error.userFacing)) {
          recordDiagnostic('storage', error, 'backup-import-read');
        }
        throw (error && error.userFacing) ? error : stageError('error.backup.importReadFailed', error);
      }
      // ── 阶段 2：解析 JSON。选错文件是最常见的用户操作失误，文案要点明 ──
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        recordDiagnostic('storage', error, 'backup-import-parse');
        throw stageError('error.backup.importParseFailed', error);
      } finally {
        // 文本与解析结果同时常驻 = 白白多占一份（大包就是几十 MB）。
        // 解析一结束（无论成败）立刻释放引用，让 GC 能回收这整段字符串。
        raw = null;
      }
      const validation = validateBackupPayload(payload);
      if (!validation.valid) {
        // 校验文案来自 tActive，是我们自己的用户文案 ⇒ 打标记，发布构建里也要原样透出
        //（否则「不支持的备份版本：2」会被换成笼统的「备份文件无法恢复」）。
        const invalid = new Error(validation.error);
        invalid.userFacing = true;
        throw invalid;
      }
      // ── 阶段 3：写回数据。这里的异常已由 importBackup 内部回滚，文案要说明「已回滚」，
      // 否则用户不知道当前数据处于什么状态、要不要再试一次 ──
      let result;
      try {
        result = await importBackup(payload, mode);
      } catch (error) {
        // importBackup 自己抛的 userFacing 错误（如「无法读取待恢复数据」）已是完整文案，直接透出
        if (error && error.userFacing) throw error;
        recordDiagnostic('storage', error, 'backup-import-apply');
        throw stageError('error.backup.importInterrupted', error);
      }
      // ── 阶段 4：刷新界面。数据**已经写盘成功**，这里的失败绝不能报成「导入失败」——
      // 那会让用户以为数据没恢复而反复重试。改成「成功提示 + 一条刷新警告」，
      // 且**不 return**：否则会连带跳过下面的「部分密钥未恢复」提示（那是一条独立的、
      // 会让人 401 的静默失败，不能因为刷新失败就吞掉）。
      let refreshWarning = '';
      try {
        await onImported?.();
      } catch (error) {
        recordDiagnostic('storage', error, 'backup-import-refresh');
        refreshWarning = stageError('error.backup.importRefreshFailed', error).message;
      }
      const doneBody = result.secretsCount > 0
        ? t('backup.alert.importDone.bodySecrets', { keys: result.storageCount, media: result.mediaCount, secrets: result.secretsCount })
        : t('backup.alert.importDone.body', { keys: result.storageCount, media: result.mediaCount });
      Alert.alert(
        t('backup.alert.importDone.title'),
        refreshWarning ? `${doneBody}\n\n${refreshWarning}` : doneBody,
      );
      // 有密钥没写回时必须说出来：数据恢复了、保险箱却没跟上，相关配置会「看起来正常、
      // 一发请求就 401」——这是最容易被当成「导入坏了」的静默失败。
      if (result.secretsFailed > 0) {
        Alert.alert(
          t('backup.alert.importSecretsFailed.title'),
          t('backup.alert.importSecretsFailed.body', { count: result.secretsFailed })
        );
      }
    } catch (error) {
      // 走到这里说明错误**没有**被上面任何阶段接管（预期不会发生）：兜底文案保持诚实，
      // 同时把原始错误写进诊断日志，避免又出现「只看到笼统文案、无从定位」。
      if (!(error && error.userFacing)) {
        recordDiagnostic('storage', error, 'backup-import-unclassified');
      }
      Alert.alert(t('backup.alert.importFailed.title'), userMessage(error) || t('backup.alert.importFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('backup.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('backup.closeA11y')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.sectionTitle}>{t('backup.export.section')}</Text>
            <View style={styles.modeRow}>
              <TouchableOpacity
                style={[styles.modeButton, mode === 'full' && styles.modeButtonActive]}
                onPress={() => setMode('full')}
                disabled={busy}
                activeOpacity={0.8}
              >
                <Text style={[styles.modeText, mode === 'full' && styles.modeTextActive]}>{t('backup.mode.full')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeButton, mode === 'quick' && styles.modeButtonActive]}
                onPress={() => setMode('quick')}
                disabled={busy}
                activeOpacity={0.8}
              >
                <Text style={[styles.modeText, mode === 'quick' && styles.modeTextActive]}>{t('backup.mode.quick')}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>{mode === 'full' ? t('backup.mode.fullHint') : t('backup.mode.quickHint')}</Text>
            <View style={styles.capabilityRow}>
              <View style={styles.linkLeft}>
                <Ionicons name="key-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.linkText}>{t('backup.secrets.label')}</Text>
              </View>
              <Switch
                value={includeSecrets}
                onValueChange={toggleSecrets}
                disabled={busy}
                trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                thumbColor={theme.colors.primaryContrast}
              />
            </View>
            {includeSecrets ? <Text style={styles.warnHint}>{t('backup.secrets.hint')}</Text> : null}
            <TouchableOpacity style={styles.primaryButton} onPress={handleExport} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="share-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>{busy ? progressText(progress, t) : t('backup.export')}</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('backup.hint')}</Text>
            {busy ? (
              <>
                <Text style={styles.progressHint}>
                  {t('backup.progressHint')}
                </Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={cancelExport} activeOpacity={0.8}>
                  <Ionicons name="close-circle-outline" size={18} color={theme.colors.accentText} />
                  <Text style={styles.secondaryText}>{t('backup.cancelExport')}</Text>
                </TouchableOpacity>
              </>
            ) : null}
            <Text style={styles.sectionTitle}>{t('backup.restore.section')}</Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => handleImport('merge')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="git-merge-outline" size={18} color={theme.colors.accentText} />
              <Text style={styles.secondaryText}>{t('backup.restore.merge')}</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('backup.restore.mergeHint')}</Text>
            <TouchableOpacity style={styles.dangerButton} onPress={() => handleImport('replace')} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="cloud-download-outline" size={18} color={theme.colors.primaryContrast} />
              <Text style={styles.primaryText}>{t('backup.restore.replace')}</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('backup.restore.replaceHint')}</Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '82%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 18 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  warnHint: { color: theme.colors.warning || theme.colors.danger, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  modeRow: { flexDirection: 'row', marginBottom: 10 },
  modeButton: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: tokens.radius.md, borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.4), backgroundColor: theme.colors.primaryAlpha(0.08) },
  modeButtonActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  modeText: { color: theme.colors.accentText, fontSize: fonts.scaled(14), fontWeight: '700' },
  modeTextActive: { color: theme.colors.primaryContrast },
  capabilityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, marginBottom: 4 },
  linkLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  linkText: { color: theme.colors.text, fontSize: fonts.scaled(14), marginLeft: 8 },
  progressHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginBottom: 8 },
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800', marginTop: 18, marginBottom: 8 },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primary, borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
  primaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  secondaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryAlpha(0.12), borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.4), borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
  secondaryText: { color: theme.colors.accentText, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  dangerButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.danger, borderRadius: tokens.radius.md, paddingVertical: 12, marginBottom: 8 },
});
