// 角色卡分享（桌面）：分享码 / 二维码 / 从剪贴板导入。
//
// 与手机 character/CardShareModal 同一条编码链（share/cardShare.js 的
// encodeCardShareCode：JSON → deflate → base64url → EC2CARD1:）。
// 桌面不需要扫码器：二维码用共享层 exportShareQrFile 生成 PNG，直接落到 documents/
// 之下（用户可另存或发给别人）；导入走剪贴板粘贴。
//
// 容量判定用共享层 planShareCode（单张二维码上限 QR_MAX_CODE_CHARS）；装不下时
// 如实说明并只给「复制分享码」——与手机同口径，不假装二维码还在。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { encodeCardShareCode, isCardShareCode, planShareCode } from '../../../src/share/cardShare.js';
import { cardToJson, exportShareQrFile } from '../../../src/character/cardExporter.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { Button, Card, Field, Row, TextInput } from '../settings/ui.jsx';

export default function CardSharePanel({ character, palette, fonts, onImportCard }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [qrUri, setQrUri] = useState('');
  const [pasteDraft, setPasteDraft] = useState('');

  if (!character) return null;

  // 分享码在编码阶段就可能抛（空卡），所以包一层并给出明确提示。
  const buildCode = () => {
    try {
      return encodeCardShareCode(cardToJson(character));
    } catch (error) {
      return '';
    }
  };
  const code = buildCode();
  const plan = planShareCode(code);

  const copyCode = async () => {
    if (!plan.code) {
      Alert.alert(t('character.share.fail.title'), t('character.share.qrFail'));
      return;
    }
    try {
      await getBridge().clipboard.write(plan.code);
      Alert.alert(t('character.share.copied.title'), t('character.share.copied.body'));
    } catch (error) {
      Alert.alert(t('character.share.fail.title'), t('common.error.retryLater'));
    }
  };

  const makeQr = async () => {
    if (!plan.fits || busy) return;
    setBusy(true);
    try {
      // 共享层把 PNG 写在 cache/card-share/；这里再复制到 documents 供 mediaUrl 读取。
      const produced = await exportShareQrFile(plan.code, { scale: 8 });
      const destination = `${String((getBridge().app.paths || {}).documentDirectory || '')}card-share/qr-${Date.now()}.png`;
      await getBridge().fs.copy(produced.uri, destination).catch(() => {});
      setQrUri(destination);
    } catch (error) {
      Alert.alert(t('character.share.fail.title'), t('character.share.qrFail'));
    } finally {
      setBusy(false);
    }
  };

  // 从剪贴板导入：读出来先校验前缀（isCardShareCode），再走与角色卡导入同一条链路。
  const importFromClipboard = async () => {
    if (busy) return;
    let text = String(pasteDraft || '').trim();
    if (!text) {
      try {
        text = String(await getBridge().clipboard.read() || '').trim();
      } catch (error) {
        text = '';
      }
    }
    if (!text) {
      Alert.alert(t('character.share.pasteEmpty.title'), t('character.share.pasteEmpty.body'));
      return;
    }
    if (!isCardShareCode(text)) {
      // 不是分享码（可能粘错了）：用共享层的错误码文案，不自己编一句。
      Alert.alert(t('character.share.fail.title'), t('error.share.invalidCode'));
      return;
    }
    if (typeof onImportCard !== 'function') return;
    setBusy(true);
    try {
      // 解码 + 落库都由宿主走既有角色卡导入链路（addCharacter/ensureCharacterSession）。
      await onImportCard(text);
      setPasteDraft('');
    } catch (error) {
      Alert.alert(t('character.share.fail.title'), String((error && error.message) || t('common.error.retryLater')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('character.share.title')} hint={t('character.share.importHint')} palette={palette} fonts={fonts}>
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
        {t('character.share.meta', {
          tags: (Array.isArray(character.tags) ? character.tags : []).length,
          entries: (Array.isArray(character.lorebook) ? character.lorebook : []).length,
          size: plan.chars,
        })}
      </div>
      <Row>
        <Button
          label={t('character.share.copy')}
          onClick={copyCode}
          palette={palette}
          fonts={fonts}
          primary
          disabled={!plan.code}
        />
        {plan.fits ? (
          <Button
            label={busy ? t('character.share.sharing') : t('character.share.qrTitle')}
            onClick={makeQr}
            palette={palette}
            fonts={fonts}
            disabled={busy}
          />
        ) : null}
      </Row>
      {/* 装不进二维码时如实说明，只给复制分享码这条路。 */}
      {!plan.fits && plan.chars > 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.7 }}>
          {t('character.share.tooLarge.body', { size: plan.chars, limit: plan.limit })}
        </div>
      ) : null}
      {qrUri ? (
        <>
          <img
            src={mediaUrl(qrUri) || ''}
            alt=""
            style={{ width: 200, height: 200, imageRendering: 'pixelated', border: `1px solid ${palette.divider}` }}
          />
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('character.share.qrHint')}
          </div>
        </>
      ) : null}
      <Field label={t('character.share.pasteImportHint')} palette={palette} fonts={fonts}>
        <Row>
          <div style={{ flex: 1, minWidth: 180 }}>
            <TextInput
              value={pasteDraft}
              onChange={setPasteDraft}
              placeholder="EC2CARD1:…"
              palette={palette}
              fonts={fonts}
            />
          </div>
          <Button
            label={t('character.share.pasteImport')}
            onClick={importFromClipboard}
            palette={palette}
            fonts={fonts}
            disabled={busy}
          />
        </Row>
      </Field>
    </Card>
  );
}
