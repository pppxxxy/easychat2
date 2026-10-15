// FEAT-AC3：「悬浮球头像」设置卡（看屏幕面板内）。
//
// 三档（用户诉求）：默认（App 图标）/ 自定义图片 / 跟随当前角色头像。
//
// 为什么单独一个组件：ScreenWatchScreen.js 贴着 800 行棘轮，而这块的状态与交互
//（读配置 / 三选一 / 选图+落盘 / 推送原生 / 预览）是自足的——与 FrameRecognitionCard
// 同一个理由拆出来。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { Card } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  OVERLAY_AVATAR_MODES,
  getOverlayAvatarSettings,
  saveOverlayAvatarSettings,
} from '../storage/settings/overlayAvatar.js';
import { copyOverlayAvatarFile, deleteOverlayAvatarFile } from './capture.js';
import { pushOverlayAvatar } from './pushOverlayAvatar.js';

export default function AvatarCard() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // null = 还没读到（显示检查中，不猜一档出来——猜错会让用户以为设置没生效）。
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOverlayAvatarSettings()
      .then(stored => { if (!cancelled) setSettings(stored); })
      .catch(() => { if (!cancelled) setSettings({ mode: 'default', customUri: '' }); });
    return () => { cancelled = true; };
  }, []);

  // 落盘 + 立刻推原生（任务书 P0-3 第 2 条：改完立即生效，不必等重开悬浮窗）。
  const apply = useCallback(async next => {
    setSettings(next);
    try {
      await saveOverlayAvatarSettings(next);
    } catch (error) {
      // 落盘失败回退到磁盘真实值，避免显示一个其实没保存的选择。
      const stored = await getOverlayAvatarSettings().catch(() => null);
      if (stored) setSettings(stored);
      return false;
    }
    // 推原生失败不影响本页（悬浮窗没开时推送本来就没意义）——不弹错。
    await pushOverlayAvatar({}).catch(() => false);
    return true;
  }, []);

  const selectMode = useCallback(async mode => {
    if (!OVERLAY_AVATAR_MODES.includes(mode)) return;
    if (settings && settings.mode === mode) return;
    setBusy(true);
    try {
      // 离开 custom 档时删掉旧图（固定文件名，留着也只是垃圾）；
      // 但**只在真的离开 custom 时删**，免得用户来回切时把图弄丢。
      const leavingCustom = settings && settings.mode === 'custom' && mode !== 'custom';
      const previousUri = settings ? settings.customUri : '';
      const ok = await apply({ ...(settings || {}), mode });
      if (ok && leavingCustom && previousUri) await deleteOverlayAvatarFile(previousUri);
    } finally {
      setBusy(false);
    }
  }, [apply, settings]);

  const pickImage = useCallback(async () => {
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
      });
      const asset = result && !result.canceled && result.assets && result.assets[0];
      if (!asset || !asset.uri) return;
      // 复制到专属稳定路径（不引用相册 uri——源被删/权限失效都不该波及头像）。
      const stableUri = await copyOverlayAvatarFile(asset.uri, asset.fileName || '');
      await apply({ mode: 'custom', customUri: stableUri });
    } catch (error) {
      Alert.alert(t('screenWatch.avatar.pickFailed.title'), t('screenWatch.avatar.pickFailed.body'));
    } finally {
      setBusy(false);
    }
  }, [apply, t]);

  const current = settings || { mode: 'default', customUri: '' };
  const options = [
    { id: 'default', label: t('screenWatch.avatar.mode.default') },
    { id: 'character', label: t('screenWatch.avatar.mode.character') },
    { id: 'custom', label: t('screenWatch.avatar.mode.custom') },
  ];

  return (
    <Card style={styles.card}>
      <Text style={styles.title}>{t('screenWatch.avatar.title')}</Text>
      {/* 如实说明「跟随角色」在两种 scope 下的差异——否则用户会以为工作区也该显示角色头像 */}
      <Text style={styles.hint}>{t('screenWatch.avatar.hint')}</Text>
      <View style={styles.row}>
        {options.map(option => {
          const active = current.mode === option.id;
          return (
            <TouchableOpacity
              key={option.id}
              style={[styles.chip, active && styles.chipActive]}
              disabled={busy || settings === null}
              onPress={() => selectMode(option.id)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {current.mode === 'custom' ? (
        <View style={styles.customRow}>
          {/* P1：选完即时预览（同一张图） */}
          {current.customUri ? (
            <Image source={{ uri: current.customUri }} style={styles.preview} />
          ) : null}
          <TouchableOpacity style={styles.pickButton} disabled={busy} onPress={pickImage}>
            <Text style={styles.pickText}>{t('screenWatch.avatar.pick')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </Card>
  );
}

function createStyles(theme, fonts, tokens) {
  const colors = (theme && theme.colors) || {};
  return StyleSheet.create({
    card: { marginBottom: (tokens && tokens.space && tokens.space.md) || 12 },
    title: { color: colors.text, fontSize: fonts?.body || 14, fontWeight: '600', marginBottom: 4 },
    hint: { color: colors.textMuted, fontSize: fonts?.caption || 12, marginBottom: 8, lineHeight: 17 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border || '#3a3a5a',
    },
    chipActive: { backgroundColor: colors.primaryAlpha ? colors.primaryAlpha(0.2) : '#3a3a5a' },
    chipText: { color: colors.textMuted, fontSize: fonts?.caption || 12 },
    chipTextActive: { color: colors.text, fontWeight: '600' },
    customRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 },
    preview: { width: 40, height: 40, borderRadius: 20 },
    pickButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: colors.primaryAlpha ? colors.primaryAlpha(0.2) : '#3a3a5a',
    },
    pickText: { color: colors.text, fontSize: fonts?.caption || 12 },
  });
}
