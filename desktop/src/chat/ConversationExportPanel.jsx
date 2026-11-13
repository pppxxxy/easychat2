// 对话导出（桌面）：Markdown / HTML 两种格式，写出后经系统「另存为」保存。
//
// 与手机的差别（都是平台差异，不是口径差异）：
//   · 手机的三种格式里有「长图」——靠 react-native-view-shot 截屏；桌面没有等价物，
//     而且桌面用户要的是可归档的文本文件，所以只提供 Markdown / HTML；
//   · 手机写进 cache 后交给系统分享面板；桌面写进 cache 后弹「另存为」对话框
//     （backup:saveAs，源必须在 documents/cache 内 —— 见 electron/ipc/backupFiles.js）。
//
// 内容组织完全复用共享层 conversationExport.js（collectExportMessages /
// buildExportEntries / toMarkdown / toHtml / exportFileName / sanitizeFileName）：
// 截断上限、说话人标注、时间格式、文件命名与手机逐字一致。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  buildExportEntries,
  collectExportMessages,
  exportFileName,
  formatExportTime,
  toHtml,
  toMarkdown,
} from '../../../src/chat/conversationExport.js';
import { writeChatExportText } from '../../../src/storage/chatExport.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { Button } from '../settings/ui.jsx';

const FORMATS = ['markdown', 'html'];

export default function ConversationExportPanel({
  open,
  onClose,
  messages,
  title,
  characterName,
  userName,
  isGroup,
  palette,
  fonts,
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState('markdown');
  const [busy, setBusy] = useState(false);

  // 预览与导出用同一份数据：先截断再渲染，避免「预览看到 500 条、导出只有 300 条」。
  const prepared = useMemo(() => {
    if (!open) return null;
    const collected = collectExportMessages(messages);
    const docTitle = title || t('chat.export.defaultTitle');
    const exportedAt = formatExportTime(Date.now());
    const entries = buildExportEntries(collected.messages, {
      userName,
      characterName: isGroup ? t('chat.export.groupName') : characterName,
    });
    // toMarkdown / toHtml 的 meta 由 normalizeMeta 统一读这五个字段（含截断说明），
    // 少传 count/truncated 会让导出的头信息变成「共 0 条」。
    const meta = {
      title: docTitle,
      exportedAt,
      count: entries.length,
      truncated: collected.truncated,
      omitted: collected.omitted,
    };
    return { ...collected, entries, exportedAt, docTitle, meta };
  }, [open, messages, userName, characterName, isGroup, t, title]);

  if (!open || !prepared) return null;

  const empty = prepared.entries.length === 0;

  const run = async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      const content = format === 'html'
        ? toHtml(prepared.entries, prepared.meta)
        : toMarkdown(prepared.entries, prepared.meta);
      const fileName = exportFileName(
        { title: prepared.docTitle, exportedAt: prepared.exportedAt },
        format === 'html' ? 'html' : 'md'
      );
      const written = await writeChatExportText({ fileName, content });
      // 另存为：源在 cache 内（上面刚写的），由主进程校验路径边界后复制到用户选的位置。
      const saved = await getBridge().backup.saveAs(
        written.uri,
        fileName,
        [{ name: format === 'html' ? 'HTML' : 'Markdown', extensions: [format === 'html' ? 'html' : 'md'] }]
      );
      if (saved && !saved.canceled) {
        // 只是清理临时产物，失败无所谓（cache 目录另有滚动清理）。
        getBridge().fs.delete(written.uri, true).catch(() => {});
        onClose();
      }
    } catch (error) {
      Alert.alert(t('chat.export.failed.title'), t('chat.export.failed.body'));
    } finally {
      setBusy(false);
    }
  };

  const tab = id => {
    const active = format === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setFormat(id)}
        disabled={busy}
        style={{
          background: active ? palette.primary : 'transparent',
          color: active ? palette.primaryContrast : palette.textMuted,
          border: `1px solid ${active ? palette.primary : palette.divider}`,
          borderRadius: 8,
          padding: '5px 12px',
          fontSize: fonts.scaled(12),
          fontWeight: active ? 700 : 500,
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {t(`chat.export.format.${id}`)}
      </button>
    );
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 49,
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
          maxHeight: '86vh',
          overflow: 'auto',
          background: palette.surface,
          border: `1px solid ${palette.divider}`,
          borderRadius: 14,
          padding: 20,
          color: palette.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('chat.export.title')}</strong>
          <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>{FORMATS.map(tab)}</div>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>
          {t(format === 'html' ? 'chat.export.hint.html' : 'chat.export.hint.markdown')}
        </div>

        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
          {t('chat.export.meta', { time: prepared.exportedAt, count: prepared.entries.length })}
          {prepared.truncated
            ? t('chat.export.truncated', { count: prepared.truncated })
            : ''}
        </div>

        {empty ? (
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>{t('chat.export.empty')}</div>
        ) : (
          // 文本预览：Markdown 直接显示原文（桌面用户看得懂源码），
          // HTML 不能内嵌 iframe（CSP 会拦），改为显示同源的 Markdown 视图 +
          // 说明「HTML 是排版版」。比手机省一个 WebView，也不假装能所见即所得。
          <div style={{
            maxHeight: '46vh',
            overflow: 'auto',
            background: palette.surfaceAlt,
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            padding: '10px 12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: fonts.scaled(12),
            lineHeight: 1.65,
            color: palette.text,
            fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
          }}
          >
            {toMarkdown(prepared.entries, { title: title || t('chat.export.defaultTitle') })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button label={t('greetingPicker.cancel')} onClick={onClose} palette={palette} fonts={fonts} disabled={busy} />
          <Button
            label={busy ? t('backup.progress.ratio') : t('chat.export.shareText')}
            onClick={run}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy || empty}
          />
        </div>
      </div>
    </div>
  );
}