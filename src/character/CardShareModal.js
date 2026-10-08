// 角色卡分享：把一张角色卡变成一个二维码 / 一段可粘贴的分享码 / 一张带卡数据的 PNG。
//
// 二维码里放的是「分享码」（EC2CARD1: + deflate + base64url），不是 PNG——
// 二维码容量只有 2953 字节，而 PNG 动辄几百 KB，塞不进去。所以两条路并存：
//   · 内容装得下 → 给二维码，对方扫一下就得到同一段分享码；
//   · 内容太大   → 只给「复制分享码」与「分享 PNG 图片」，并如实说明原因。
//
// 关于扫码：**本应用目前没有内置扫码器**（未安装 expo-camera 之类的依赖）。
// 所以这里不承诺「扫一下就导入」——二维码的价值是让用户用任何扫码工具读出
// 那段文本，再回到本页粘贴。界面文案如实这么写，不假装有扫码入口。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import {
  cardToJson,
  exportSharePngFile,
  exportShareQrFile,
} from './cardExporter.js';
import { encodeCardShareCode, planShareCode, QR_MAX_CODE_CHARS } from '../share/cardShare.js';
import { Card, FieldHint, GhostButton, PrimaryButton } from '../ui/index.js';
import { maskSecrets } from '../storage/secrets.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 二维码点阵的像素放大倍数：每个格 6 像素，40 版的码（177 格）就是
// (177+8)*6 ≈ 1110 像素，清晰且不至于生成一张几 MB 的图。
const QR_SCALE = 6;
const QR_QUIET = 4;

export default function CardShareModal({
  visible,
  onClose,
  character = null,
  avatarBytes = null,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [qrUri, setQrUri] = useState('');
  const [plan, setPlan] = useState(null);

  const shareCode = useMemo(() => {
    if (!character) return '';
    try {
      return encodeCardShareCode(cardToJson(character));
    } catch (caught) {
      return '';
    }
  }, [character]);

  // 打开时生成二维码 PNG 并落盘成临时文件——<Image> 需要一个 uri，
  // 不能直接喂字节。生成失败（通常是内容太长）不报错中断，只让二维码区显示原因。
  useEffect(() => {
    if (!visible || !shareCode) {
      setQrUri('');
      setPlan(shareCode ? planShareCode(shareCode) : null);
      return undefined;
    }
    let alive = true;
    setPlan(planShareCode(shareCode));
    setError('');
    (async () => {
      const info = planShareCode(shareCode);
      if (!info.fitsQr) {
        if (alive) setQrUri('');
        return;
      }
      try {
        const uri = await exportShareQrFile(shareCode, { scale: QR_SCALE, quiet: QR_QUIET });
        if (alive) setQrUri(uri);
      } catch (caught) {
        if (alive) {
          setQrUri('');
          setError(t('character.share.qrFail'));
        }
      }
    })();
    return () => { alive = false; };
  }, [visible, shareCode, t]);

  const copyCode = useCallback(async () => {
    if (!shareCode) return;
    try {
      await Clipboard.setStringAsync(shareCode);
      Alert.alert(t('character.share.copied.title'), t('character.share.copied.body'));
    } catch (caught) {
      Alert.alert(t('character.share.fail.title'), t('common.error.retryLater'));
    }
  }, [shareCode, t]);

  // 分享「带角色数据的 PNG」：对方存图后可直接用本应用的导入功能读回。
  const sharePng = useCallback(async () => {
    if (!character || busy) return;
    setBusy(true);
    setError('');
    try {
      const uri = await exportSharePngFile(character, avatarBytes);
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/png',
          dialogTitle: t('character.share.pngDialog'),
        });
      } else {
        Alert.alert(t('character.detail.export.doneTitle'), t('character.detail.export.doneBody', { uri }));
      }
    } catch (caught) {
      Alert.alert(t('character.share.fail.title'), maskSecrets((caught && caught.message) || t('common.error.retryLater')));
    } finally {
      setBusy(false);
    }
  }, [avatarBytes, busy, character, t]);

  const tagCount = Array.isArray(character && character.tags) ? character.tags.length : 0;
  const worldCount = Array.isArray(character && character.worldInfo) ? character.worldInfo.length : 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('character.share.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Card style={styles.card}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {String((character && character.name) || '') || t('common.unnamedCharacter')}
            </Text>
            <Text style={styles.metaLine}>
              {t('character.share.meta', {
                tags: tagCount,
                entries: worldCount,
                size: shareCode ? shareCode.length : 0,
              })}
            </Text>
          </Card>

          {plan && plan.fitsQr ? (
            <Card style={styles.card}>
              <Text style={styles.cardTitle}>{t('character.share.qrTitle')}</Text>
              {qrUri ? (
                <View style={styles.qrWrap}>
                  <Image source={{ uri: qrUri }} style={styles.qrImage} resizeMode="contain" />
                </View>
              ) : (
                <View style={styles.qrLoading}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                </View>
              )}
              <FieldHint style={styles.hint}>{t('character.share.qrHint')}</FieldHint>
            </Card>
          ) : plan ? (
            <Card style={styles.card}>
              <View style={styles.warnRow}>
                <Ionicons name="information-circle-outline" size={15} color={theme.colors.star} />
                <Text style={styles.warnTitle}>{t('character.share.tooLarge.title')}</Text>
              </View>
              <Text style={styles.warnBody}>
                {t('character.share.tooLarge.body', { size: plan.chars, limit: QR_MAX_CODE_CHARS })}
              </Text>
              <FieldHint style={styles.hint}>{t('character.share.tooLarge.hint')}</FieldHint>
            </Card>
          ) : null}

          <PrimaryButton
            title={t('character.share.copy')}
            onPress={copyCode}
            disabled={!shareCode}
            style={styles.primaryButton}
          />
          <GhostButton
            title={busy ? t('character.share.sharing') : t('character.share.sharePng')}
            onPress={sharePng}
            disabled={busy || !character}
            style={styles.secondaryButton}
          />

          <FieldHint style={styles.hint}>{t('character.share.importHint')}</FieldHint>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 32 },
  card: { marginBottom: tokens.metrics.cardGap },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 6 },
  metaLine: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16) },
  qrWrap: {
    alignItems: 'center',
    marginTop: 10,
    padding: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: '#ffffff',
  },
  qrImage: { width: 240, height: 240 },
  qrLoading: { alignItems: 'center', paddingVertical: 40 },
  warnRow: { flexDirection: 'row', alignItems: 'center' },
  warnTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 5 },
  warnBody: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: 6,
  },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 10 },
  primaryButton: { marginTop: 4 },
  secondaryButton: { marginTop: 10 },
  errorText: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginTop: 10, lineHeight: fonts.scaled(18) },
});
