// 诊断日志（桌面）：查看 / 复制 / 清空本机留存的结构化诊断记录。
//
// 对应手机 DiagnosticsModal。记录来源与手机同一套：
//   · 共享层在出错处调用 recordDiagnostic(kind, error, context)（App.js 的未捕获异常、
//     AppContext 的启动失败、备份/向量/主动消息等各域的失败路径）；
//   · 读取与格式化复用 storage/diagnostics.js 的 getDiagnostics / formatDiagnostics；
//   · 文本里已脱敏（maskSecrets 在写入时执行），复制出去可直接贴给开发者。
//
// 桌面为什么需要它：桌面没有 Android 的 logcat，用户遇到问题只能截图；有了这一页，
// 「启动就白屏」「备份失败」这类问题能直接复制一段内容回报。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  clearDiagnostics,
  formatDiagnostics,
  getDiagnostics,
} from '../../../src/storage/diagnostics.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { Button, Card, Row } from './ui.jsx';

export default function DiagnosticsCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const entries = await getDiagnostics();
      setList(Array.isArray(entries) ? entries : []);
    } catch (error) {
      // 读不出来 ≠ 没有记录：明确提示，别让用户以为日志是空的。
      setFailed(true);
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const text = formatDiagnostics(list);

  const copy = async () => {
    if (!text) return;
    try {
      await getBridge().clipboard.write(text);
      Alert.alert(t('diagnostics.alert.copied.title'), t('diagnostics.alert.copied.body'));
    } catch (error) {
      Alert.alert(t('diagnostics.alert.copyFailed.title'), t('diagnostics.alert.copyFailed.body'));
    }
  };

  const clear = () => {
    if (list.length === 0) return;
    Alert.alert(t('diagnostics.alert.clear.title'), t('diagnostics.alert.clear.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('diagnostics.alert.clear.confirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await clearDiagnostics();
            await load();
          } catch (error) {
            // 清空失败时记录仍在（存储写失败），如实告知而不是显示「已清空」。
            Alert.alert(t('diagnostics.alert.clearFailed.title'), t('diagnostics.alert.clearFailed.body'));
          }
        },
      },
    ]);
  };

  return (
    <Card title={t('diagnostics.title')} hint={t('diagnostics.hint')} palette={palette} fonts={fonts}>
      {failed ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {t('diagnostics.readFailed')}
        </div>
      ) : null}
      <Row>
        <Button
          label={loading ? t('backup.progress.ratio') : t('diagnostics.title')}
          onClick={load}
          palette={palette}
          fonts={fonts}
          disabled={loading}
        />
        <Button label={t('diagnostics.copyAll')} onClick={copy} palette={palette} fonts={fonts} disabled={!text} />
        <Button
          label={t('diagnostics.clear')}
          onClick={clear}
          palette={palette}
          fonts={fonts}
          tone={palette.danger || '#ff5a5f'}
          disabled={list.length === 0}
        />
      </Row>
      {!loading && !failed && list.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {t('diagnostics.empty')}
        </div>
      ) : null}
      {text ? (
        <div style={{
          maxHeight: '46vh',
          overflow: 'auto',
          background: palette.surfaceAlt,
          border: `1px solid ${palette.divider}`,
          borderRadius: 10,
          padding: '10px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: fonts.scaled(11),
          lineHeight: 1.6,
          color: palette.text,
          fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
        }}
        >
          {text}
        </div>
      ) : null}
    </Card>
  );
}