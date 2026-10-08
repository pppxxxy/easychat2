// 设置面板的「Python 环境」小节（v4 T2，按核实报告 §2.4 修正）。
//
// 与 v4 原设计的两处偏差，都写在界面上：
//   1) **没有运行时 pip**：包只能构建时装进 APK，所以这里只列「已打进包的依赖」，
//      不提供装包与镜像源切换（那是做不到的，不是没做）；
//   2) **模型不能运行 Python**：Chaquopy 无法中断正在跑的脚本，跑飞的脚本杀不掉，
//      所以 run_python 不进 agent 工具表——只允许用户在这里亲手跑。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, PrimaryButton } from '../../ui/index.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../../storage/workspace.js';
import { defaultWorkspaceRoot } from '../native.js';
import { sandboxPathFromUri } from '../shell.js';
import {
  isPythonAvailable,
  probeInstalledPackages,
  PYTHON_BUNDLED_PACKAGES,
  pythonCwdPath,
  pythonGateReason,
  runPythonScript,
} from '../python.js';

const DEFAULT_CODE = 'print("hello from Python")';

export default function PythonSection({ characterId }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [gate, setGate] = useState('NOT_BUNDLED');
  // 解释器能否启动要问原生（异步）：Chaquopy 的「模块已注册」不等于「Python 能跑」，
  // 上一版把前者当后者显示，用户点运行才看到报错。首次启动要解压标准库，故有加载态。
  const [checking, setChecking] = useState(true);
  // 实装依赖（向解释器查）：null = 没查到（回落成「构建时声明」的说法）。
  const [installed, setInstalled] = useState(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const cwdRef = useRef('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        const available = await isPythonAvailable();
        if (!alive) return;
        setGate(pythonGateReason(settings, { pythonAvailable: available }));
        try {
          cwdRef.current = pythonCwdPath(sandboxPathFromUri(defaultWorkspaceRoot()).replace(/\/+$/, ''), characterId);
        } catch (error) {
          cwdRef.current = '';
        }
        // 声明 ≠ 实装：最小原型构建会跳过 pip 块，照清单显示「已打进 APK」就是假话。
        // 只有解释器真能用时才去查（否则探测必然失败、白跑一次）。
        if (available && cwdRef.current) {
          const probed = await probeInstalledPackages({ cwdPath: cwdRef.current });
          if (!alive) return;
          setInstalled(probed);
        }
      } catch (error) {
        if (alive) setGate('NOT_BUNDLED');
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => { alive = false; };
  }, [characterId]);

  const run = useCallback(async () => {
    if (busy || checking || gate !== '' || !cwdRef.current) return;
    setBusy(true);
    setResult(null);
    try {
      const formatted = await runPythonScript({ code, cwdPath: cwdRef.current });
      if (mountedRef.current) setResult(formatted);
    } catch (error) {
      if (mountedRef.current) {
        setResult({ stdout: '', stderr: (error && error.message) || '', exitCode: -1, isError: true, truncated: false });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, checking, code, gate]);

  return (
    <View style={styles.section}>
      <FieldLabel>{t('workspace.python.title')}</FieldLabel>
      {checking ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
          <Text style={styles.statusText}>{t('workspace.python.checking')}</Text>
        </View>
      ) : gate === '' ? (
        <View style={styles.statusRow}>
          <Ionicons name="checkmark-circle-outline" size={15} color={theme.colors.primary} />
          <Text style={styles.statusText}>{t('workspace.python.available')}</Text>
        </View>
      ) : (
        <FieldHint>{t(`workspace.python.gate.${gate === 'EXTERNAL_ROOT' ? 'externalRoot' : 'notBundled'}`)}</FieldHint>
      )}

      {/* 依赖清单要区分「实装」与「声明」：最小原型构建跳过 pip 块，
          此时照声明清单显示「已打进 APK」就是假话（真机截图踩过）。 */}
      {installed ? (
        installed.installed.length > 0 ? (
          <FieldHint>
            {t('workspace.python.bundled.installed', {
              list: installed.installed.map(item => `${item.name}==${item.version}`).join(', '),
            })}
          </FieldHint>
        ) : (
          <FieldHint>{t('workspace.python.bundled.none')}</FieldHint>
        )
      ) : (
        <FieldHint>{t('workspace.python.bundled', { list: PYTHON_BUNDLED_PACKAGES.join(', ') || '—' })}</FieldHint>
      )}
      {installed && installed.missing.length > 0 ? (
        <FieldHint>
          {t('workspace.python.bundled.missing', { list: installed.missing.join(', ') })}
        </FieldHint>
      ) : null}
      <FieldHint>{t('workspace.python.noKill')}</FieldHint>

      {!checking && gate === '' ? (
        <>
          <TextInput
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={setCode}
            placeholder={t('workspace.python.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actions}>
            {busy ? <ActivityIndicator size="small" color={theme.colors.primaryMuted} /> : null}
            <PrimaryButton title={t('workspace.python.run')} small onPress={run} disabled={busy} />
          </View>
          {result ? (
            <View style={styles.outputBox}>
              {result.stdout ? <Text style={styles.stdout}>{result.stdout}</Text> : null}
              {result.stderr ? <Text style={styles.stderr}>{result.stderr}</Text> : null}
              <Text style={styles.note}>
                {result.truncated ? `${t('workspace.python.truncated')} · ` : ''}
                {t('workspace.python.exitCode', { code: result.exitCode })}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  section: { marginTop: 18 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 2 },
  statusText: { color: theme.colors.text, fontSize: fonts.scaled(12.5), marginLeft: 6 },
  input: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: fonts.scaled(12.5),
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
  },
  code: { minHeight: 88, fontFamily: 'monospace', textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 8 },
  outputBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
  },
  stdout: { color: theme.colors.text, fontSize: fonts.scaled(11.5), fontFamily: 'monospace' },
  stderr: { color: theme.colors.danger, fontSize: fonts.scaled(11.5), fontFamily: 'monospace' },
  note: { color: theme.colors.textFaint, fontSize: fonts.scaled(10.5), marginTop: 4 },
});
