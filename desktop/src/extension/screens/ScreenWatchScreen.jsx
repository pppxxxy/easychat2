// 看屏幕（桌面）：截本应用画面 → 视觉模型多模态评论 → 落库成线程。
//
// 为什么这在桌面成立（此前写「不可移植」是过期判断）：
// 手机的看屏幕 v1 用 react-native-view-shot **截自己 App**，零权限；跨应用截屏
// （MediaProjection + 悬浮窗）才是 Android 专属，手机自己也明确延后了。
// 桌面有精确对应物：webContents.capturePage()（见 electron/ipc/capture.js）。
//
// 本页复用共享层，不重写任何判定：
//   · useScreenWatchComments —— 视觉门控、提示词、多模态请求、落库、重试全在里面；
//   · captureAppScreen —— 截图 + 落盘 + 滚动清扫（经 platform/viewShot.js 适配）。
//
// 桌面上确实没有的部分：悬浮窗（在其他应用之上显示自己的 UI）与跨应用帧序列识别。
// 这层差异只在「悬浮窗」相关控件上体现——本页不做那些控件，而不是做假的开关。
import { useCallback, useEffect, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { captureAppScreen } from '../../../../src/screenWatch/capture.js';
import {
  resolveScreenWatchCapabilities,
  useScreenWatchComments,
} from '../../../../src/screenWatch/useScreenWatchComments.js';
import { maskSecrets } from '../../../../src/storage/secrets.js';
import { Alert } from '../../platform/alert.js';
import { mediaUrl } from '../../platform/mediaUrl.js';
import { Button, Card, Row, Select } from '../../settings/ui.jsx';

export default function ScreenWatchScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters } = useApp();
  const list = Array.isArray(characters) ? characters : [];
  const [characterId, setCharacterId] = useState('');
  const [vision, setVision] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [shot, setShot] = useState('');

  const comments = useScreenWatchComments({ characters: list, defaultCharacterId: characterId });

  useEffect(() => {
    if (!characterId && list.length > 0) setCharacterId(String(list[0].id || ''));
  }, [list, characterId]);

  // 依赖只能写 setCharacterId（useCallback 稳定），不能写整个 comments 对象——
  // useScreenWatchComments 每次渲染都返回新的 useMemo 结果，挂整个对象会无限重跑。
  const setHookCharacterId = comments.setCharacterId;
  useEffect(() => {
    setHookCharacterId(String(characterId || ''));
  }, [characterId, setHookCharacterId]);

  // 视觉门控：只作提示，真正的门控在共享层 generate 内部（同一口径）。
  useEffect(() => {
    let cancelled = false;
    resolveScreenWatchCapabilities(String(characterId || ''))
      .then(result => {
        if (!cancelled) setVision(result.vision === true);
      })
      .catch(() => {
        if (!cancelled) setVision(false);
      });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  // 截屏与生成分两段 try：生成失败不该显示成「截屏失败」（手机端同一教训）。
  const handleCapture = useCallback(async () => {
    if (capturing || comments.generating) return;
    setCapturing(true);
    let uri = '';
    try {
      const result = await captureAppScreen();
      uri = String(result.uri || '');
      setShot(uri);
    } catch (error) {
      Alert.alert(t('screenWatch.capture.failed.title'), t('screenWatch.capture.failed.body'));
      setCapturing(false);
      return;
    }
    try {
      await comments.generate({ imageUri: uri });
    } catch (error) {
      Alert.alert(
        t('screenWatch.generate.failed.title'),
        maskSecrets(String((error && error.message) || t('screenWatch.generate.failed.body')))
      );
    } finally {
      setCapturing(false);
    }
  }, [capturing, comments, t]);

  const busy = capturing || comments.generating;
  const roleOptions = list.map(item => ({
    value: String(item.id || ''),
    label: item.name || t('common.unnamedCharacter'),
  }));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card
        title={t('screenWatch.title')}
        hint={t('desktop.screenWatch.hint')}
        palette={palette}
        fonts={fonts}
      >
        <Row>
          <Select
            value={characterId}
            options={roleOptions}
            onChange={setCharacterId}
            palette={palette}
            fonts={fonts}
            disabled={roleOptions.length === 0 || busy}
          />
          <Button
            label={busy ? t('screenWatch.capture.busy') : t('screenWatch.capture')}
            onClick={handleCapture}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy || !characterId}
          />
          {comments.comments.length > 0 ? (
            <Button
              label={t('screenWatch.comments.clear')}
              onClick={() => comments.clearAll()}
              palette={palette}
              fonts={fonts}
              disabled={busy}
            />
          ) : null}
        </Row>

        {/* 门控提示：当前模型不识图时先说明，而不是让用户点完再看失败。 */}
        {vision === false ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
            {t('screenWatch.error.noVision')}
          </div>
        ) : null}

        {shot ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 4 }}>
            <img
              src={mediaUrl(shot) || ''}
              alt=""
              style={{
                width: 180,
                maxHeight: 140,
                objectFit: 'contain',
                borderRadius: 8,
                border: `1px solid ${palette.divider}`,
                background: palette.surfaceAlt,
              }}
            />
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
              {t('desktop.screenWatch.shotHint')}
            </div>
          </div>
        ) : null}

        {comments.error ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
            {comments.error}
          </div>
        ) : null}

        {comments.comments.length === 0 && !comments.error ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('screenWatch.empty')}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 最新在前：与手机面板一致（刚看到的画面最相关）。 */}
          {[...comments.comments].reverse().map(comment => (
            <div
              key={comment.id}
              style={{
                borderLeft: `2px solid ${palette.primaryMuted || palette.primary}`,
                paddingLeft: 8,
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              {comment.imageUri ? (
                <img
                  src={mediaUrl(comment.imageUri) || ''}
                  alt=""
                  style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 6 }}
                />
              ) : null}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: fonts.scaled(12), lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                  {String(comment.text || '')}
                </div>
                <button
                  type="button"
                  onClick={() => comments.remove(comment.id)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: palette.textFaint,
                    fontSize: fonts.scaled(10),
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}