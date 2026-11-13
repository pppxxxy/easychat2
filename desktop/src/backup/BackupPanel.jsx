// 备份与恢复面板（桌面）：整库导出/恢复 + 角色卡导入导出。
//
// 与 Android 的关系：编排逻辑（exportBackup/importBackup/readBackupText/角色卡解析）
// 全部复用共享层；这里只做桌面交互——原生对话框在 services.js 里经 IPC 完成。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import {
  applyCharacterCard,
  exportBackupToFile,
  exportCharacterCard,
  importBackupFromFile,
  pickCharacterCard,
} from './services.js';

const MB = 1024 * 1024;

function describeExport(progress, t) {
  if (!progress) return '';
  if (progress.phase === 'storage') {
    return `${t('backup.progress.busy')} ${progress.done}/${progress.total}`;
  }
  if (progress.phase === 'media') return `${t('backup.progress.writingRatio')} ${progress.done}`;
  if (progress.phase === 'packing') return t('backup.progress.writingDone');
  if (progress.phase === 'writing') {
    return `${t('backup.progress.starting')} ${Math.round((Number(progress.done) || 0) / MB)}MB`;
  }
  if (progress.phase === 'done') return t('backup.progress.done');
  return t('backup.progress.ratio');
}

function describeImport(progress, t) {
  if (!progress) return t('backup.phase.reading');
  const done = Math.round((Number(progress.bytes) || 0) / MB);
  if (Number(progress.total) > 0) {
    return t('backup.progress.readingRatio', { done, total: Math.round(Number(progress.total) / MB) });
  }
  return t('backup.progress.readingDone', { done });
}

function Section({ title, palette, fonts, children }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ fontSize: fonts.scaled(13), fontWeight: 800, color: palette.text, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

export default function BackupPanel({ open, onClose, palette, fonts, app }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('full');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);

  if (!open) return null;

  const button = (label, onClick, { primary = false, disabled = false } = {}) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !!busy}
      style={{
        background: primary ? palette.primary : 'transparent',
        color: primary ? palette.primaryContrast : palette.textMuted,
        border: primary ? 'none' : `1px solid ${palette.divider}`,
        borderRadius: 8,
        padding: '7px 14px',
        fontSize: fonts.scaled(12),
        fontWeight: primary ? 700 : 500,
        cursor: disabled || busy ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );

  const runExport = async () => {
    if (busy) return;
    setBusy('export');
    setStatusError(false);
    setStatus(t('backup.progress.starting'));
    try {
      const result = await exportBackupToFile({
        mode,
        includeSecrets,
        onProgress: progress => setStatus(describeExport(progress, t)),
      });
      if (result.canceled) {
        setStatus('');
        return;
      }
      const size = Math.round((Number(result.bytes) || 0) / MB);
      const summary = result.secretsCount > 0
        ? t('backup.summaryWithSecrets', {
          keys: result.storageCount,
          media: result.mediaCount,
          secrets: result.secretsCount,
          size,
        })
        : t('backup.summary', { keys: result.storageCount, media: result.mediaCount, size });
      if (result.incomplete) {
        Alert.alert(t('backup.alert.incomplete.title'), t('backup.alert.incomplete.body', {
          summary,
          note: t('backup.incompleteNote', {
            keys: (result.unreadableKeys || []).length,
            media: (result.unreadableMedia || []).length,
          }),
        }));
      } else {
        Alert.alert(t('backup.alert.exportDone.title'), t('backup.alert.exportDone.body', { summary }));
      }
      setStatus('');
    } catch (error) {
      setStatusError(true);
      setStatus(String((error && error.message) || ''));
      Alert.alert(t('backup.alert.exportFailed.title'), t('backup.alert.exportFailed.body'));
    } finally {
      setBusy('');
    }
  };

  const runImport = async importMode => {
    if (busy) return;
    setBusy('import');
    setStatusError(false);
    setStatus(t('backup.phase.reading'));
    try {
      const result = await importBackupFromFile({
        mode: importMode,
        onProgress: progress => setStatus(describeImport(progress, t)),
      });
      if (result.canceled) {
        setStatus('');
        return;
      }
      await app.refreshAppData().catch(() => {});
      const summary = result.result;
      Alert.alert(
        t('backup.alert.importDone.title'),
        summary.secretsCount > 0
          ? t('backup.alert.importDone.bodySecrets', {
            keys: summary.storageCount,
            media: summary.mediaCount,
            secrets: summary.secretsCount,
          })
          : t('backup.alert.importDone.body', { keys: summary.storageCount, media: summary.mediaCount })
      );
      if (summary.secretsFailed > 0) {
        Alert.alert(
          t('backup.alert.importSecretsFailed.title'),
          t('backup.alert.importSecretsFailed.body', { count: summary.secretsFailed })
        );
      }
      setStatus('');
    } catch (error) {
      setStatusError(true);
      setStatus(String((error && error.message) || ''));
      Alert.alert(
        t('backup.alert.importFailed.title'),
        String((error && error.message) || t('backup.alert.importFailed.body'))
      );
    } finally {
      setBusy('');
    }
  };

  const confirmReplace = () => {
    Alert.alert(t('backup.alert.confirmReplace.title'), t('backup.alert.confirmReplace.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('backup.alert.confirmReplace.continue'), onPress: () => runImport('replace') },
    ]);
  };

  const runExportCard = async format => {
    if (busy || !app.character) return;
    setBusy('card');
    setStatusError(false);
    setStatus(t('backup.progress.ratio'));
    try {
      const result = await exportCharacterCard(app.character, format);
      if (!result.canceled) {
        Alert.alert(
          t('character.detail.export.doneTitle'),
          t('character.detail.export.doneBody', { uri: result.path })
        );
      }
    } catch (error) {
      Alert.alert(
        t('character.detail.export.failTitle'),
        String((error && error.message) || t('common.error.retryLater'))
      );
    } finally {
      setBusy('');
      setStatus('');
    }
  };

  const runImportCard = async () => {
    if (busy) return;
    setBusy('card');
    setStatusError(false);
    setStatus(t('backup.progress.ratio'));
    try {
      const picked = await pickCharacterCard();
      if (picked.canceled) return;
      if (picked.empty) {
        Alert.alert(t('character.detail.importEmpty.title'), t('character.detail.importEmpty.body'));
        return;
      }
      const applied = await applyCharacterCard(picked, {
        addCharacter: app.addCharacter,
        ensureCharacterSession: app.ensureCharacterSession,
        updateCharacter: app.updateCharacter,
      });
      Alert.alert(
        t('character.detail.importOk.title'),
        t('backup.card.importDone', { name: applied.created && applied.created.name ? applied.created.name : picked.patch.name })
      );
    } catch (error) {
      if (error && error.code === 'TOO_LARGE') {
        Alert.alert(
          t('character.detail.importTooLarge.title'),
          t('character.detail.importTooLarge.body', { size: '32 MB' })
        );
      } else if (error && error.code === 'PARSE') {
        Alert.alert(
          t('character.detail.importParseFail.title'),
          error.detail || t('character.detail.importParseFail.fallback')
        );
      } else {
        Alert.alert(
          t('character.detail.importFail.title'),
          String((error && error.message) || t('common.error.retryLater'))
        );
      }
    } finally {
      setBusy('');
      setStatus('');
    }
  };

  const toggleSecrets = () => {
    if (includeSecrets) {
      setIncludeSecrets(false);
      return;
    }
    Alert.alert(t('backup.secrets.warn.title'), t('backup.secrets.warn.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('backup.secrets.warn.confirm'), onPress: () => setIncludeSecrets(true) },
    ]);
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 48,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: 'min(620px, 94vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <strong style={{ fontSize: fonts.scaled(16) }}>{t('backup.title')}</strong>
          <button
            type="button"
            onClick={onClose}
            title={t('backup.closeA11y')}
            style={{
              background: 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        <Section title={t('backup.export.section')} palette={palette} fonts={fonts}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {[{ id: 'full', key: 'backup.mode.full', hint: 'backup.mode.fullHint' }, { id: 'quick', key: 'backup.mode.quick', hint: 'backup.mode.quickHint' }].map(option => (
              <label key={option.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: fonts.scaled(12), cursor: 'pointer' }}>
                <input type="radio" checked={mode === option.id} onChange={() => setMode(option.id)} />
                <span>{t(option.key)}</span>
              </label>
            ))}
          </div>
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(11), marginBottom: 10 }}>
            {t(mode === 'quick' ? 'backup.mode.quickHint' : 'backup.mode.fullHint')}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: fonts.scaled(12), cursor: 'pointer', marginBottom: 4 }}>
            <input type="checkbox" checked={includeSecrets} onChange={toggleSecrets} />
            <span>{t('backup.secrets.label')}</span>
          </label>
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(11), marginBottom: 10 }}>
            {t('backup.secrets.hint')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {button(busy === 'export' ? t('backup.progress.ratio') : t('backup.export'), runExport, { primary: true })}
          </div>
        </Section>

        <Section title={t('backup.import.section')} palette={palette} fonts={fonts}>
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(11), marginBottom: 10 }}>
            {t('backup.import.hint')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {button(t('backup.import.merge'), () => runImport('merge'))}
            {button(t('backup.import.replace'), confirmReplace)}
          </div>
        </Section>

        <Section title={t('backup.card.section')} palette={palette} fonts={fonts}>
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(11), marginBottom: 10 }}>
            {app.character ? app.character.name : t('backup.card.noCharacter')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {button(t('backup.card.exportPng'), () => runExportCard('png'), { disabled: !app.character })}
            {button(t('backup.card.exportJson'), () => runExportCard('json'), { disabled: !app.character })}
            {button(t('backup.card.import'), runImportCard)}
          </div>
        </Section>

        {status ? (
          <div style={{
            marginTop: 4,
            color: statusError ? (palette.danger || '#ff5a5f') : palette.textMuted,
            fontSize: fonts.scaled(11),
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          >
            {status}
          </div>
        ) : null}
      </div>
    </div>
  );
}
