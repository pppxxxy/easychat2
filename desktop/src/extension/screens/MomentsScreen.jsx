// 动态（桌面）：与手机 MomentsView 同一套列表与交互（点赞 / 评论 / 删除）。
//
// 数据与判定全部复用共享层：
//   · storage/moments.js —— getMomentsStatus / updateMoments（含损坏保护：读失败拒绝覆盖）；
//   · moments/commentThread.js —— 评论线程铺平（回复层级）。
//
// 三条纪律照抄手机：
//   · 读失败（corrupt）不能当成「没有动态」——否则下一次写入会把整表清空，
//     所以走 getMomentsStatus 并显式提示，而不是 getMoments().catch(() => [])；
//   · 点赞/评论走 updateMoments（内部串行队列 + 读失败拒绝写），不在界面里直接存档；
//   · 删除是破坏性操作，二次确认。
//
// 桌面不做的部分：「角色回复评论」需要模型调用 + 后台任务，手机侧由 commentRunner
// 驱动；桌面只保留用户自己的评论（写入同一份数据结构，手机端会读到）。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { getMomentsStatus, updateMoments } from '../../../../src/storage/moments.js';
import { flattenCommentThread } from '../../../../src/moments/commentThread.js';
import { mediaUrl } from '../../platform/mediaUrl.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Row, TextInput } from '../../settings/ui.jsx';

// 时间格式与手机 moments.time.format 同口径（纯展示）。
function formatMomentTime(timestamp, t) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return t('moments.time.format', {
    m: date.getMonth() + 1,
    d: date.getDate(),
    hh: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
  });
}

function Avatar({ uri, name, palette, fonts, size = 34 }) {
  const src = useMemo(() => (uri ? mediaUrl(uri) : null), [uri]);
  if (src) {
    return <img src={src} alt="" style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', flex: 'none' }} />;
  }
  return (
    <span style={{
      width: size,
      height: size,
      flex: 'none',
      borderRadius: size / 2,
      background: palette.surfaceAlt,
      color: palette.textMuted,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: fonts.scaled(size * 0.42),
    }}
    >
      {String(name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function MomentsScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [corrupt, setCorrupt] = useState(false);
  const [moments, setMoments] = useState([]);
  const [commentDraft, setCommentDraft] = useState({});
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getMomentsStatus();
      setMoments(status.moments || []);
      setCorrupt(status.status === 'corrupt');
    } catch (error) {
      // 读异常（不是 corrupt）同样不能当成空表：保留当前列表并告知。
      setCorrupt(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 点赞/取消点赞走 updateMoments：存储层串行队列 + 读失败拒绝覆盖。
  const toggleLike = async moment => {
    if (!moment || busyId) return;
    setBusyId(String(moment.id));
    try {
      let nextLiked = false;
      await updateMoments(list => list.map(item => {
        if (!item || item.id !== moment.id) return item;
        nextLiked = !item.likedByUser;
        return { ...item, likedByUser: nextLiked };
      }));
      setMoments(current => current.map(item => (
        item && item.id === moment.id ? { ...item, likedByUser: nextLiked } : item
      )));
    } catch (error) {
      Alert.alert(t('moments.alert.saveFailed.title'), t('moments.alert.saveFailed.bodyReadFailed'));
    } finally {
      setBusyId('');
    }
  };

  const addComment = async moment => {
    const draft = String((commentDraft[moment.id] || '')).trim();
    if (!moment || !draft || busyId) return;
    setBusyId(String(moment.id));
    try {
      const comment = {
        id: `c-${Date.now()}`,
        author: t('moments.default.userName'),
        text: draft,
        createdAt: Date.now(),
        byUser: true,
      };
      let next = null;
      await updateMoments(list => list.map(item => {
        if (!item || item.id !== moment.id) return item;
        const comments = Array.isArray(item.comments) ? item.comments : [];
        next = { ...item, comments: [...comments, comment] };
        return next;
      }));
      if (next) {
        setMoments(current => current.map(item => (item && item.id === moment.id ? next : item)));
      }
      setCommentDraft(current => ({ ...current, [moment.id]: '' }));
    } catch (error) {
      // 评论仍留在输入框里（与手机一致的提示口径），用户可重试。
      Alert.alert(t('moments.alert.commentSaveFailed.title'), t('moments.alert.commentSaveFailed.body'));
    } finally {
      setBusyId('');
    }
  };

  const removeMoment = moment => {
    if (!moment || busyId) return;
    Alert.alert(t('moments.alert.delete.title'), t('moments.alert.delete.body'), [
      { text: t('moments.cancel'), style: 'cancel' },
      {
        text: t('moments.delete'),
        style: 'destructive',
        onPress: async () => {
          setBusyId(String(moment.id));
          try {
            await updateMoments(list => list.filter(item => !item || item.id !== moment.id));
            setMoments(current => current.filter(item => !item || item.id !== moment.id));
          } catch (error) {
            Alert.alert(t('moments.alert.saveFailed.title'), t('moments.alert.saveFailed.bodyReadFailed'));
          } finally {
            setBusyId('');
          }
        },
      },
    ]);
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.home.moments')} hint={t('ext.home.moments.desc')} palette={palette} fonts={fonts}>
        <Row>
          <Button
            label={loading ? t('backup.progress.ratio') : t('moments.title')}
            onClick={load}
            palette={palette}
            fonts={fonts}
            disabled={loading}
          />
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('ext.home.moments.summary', { count: moments.length })}
          </span>
        </Row>
        {corrupt ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
            {t('moments.alert.saveFailed.bodyReadFailed')}
          </div>
        ) : null}
      </Card>

      {!loading && moments.length === 0 && !corrupt ? (
        <Card palette={palette} fonts={fonts} title={t('ext.home.moments')}>
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>
            {t('moments.empty.description')}
          </div>
        </Card>
      ) : null}

      {moments.map(moment => {
        const comments = flattenCommentThread(Array.isArray(moment.comments) ? moment.comments : []);
        const liked = moment.likedByUser === true;
        return (
          <Card
            key={moment.id}
            palette={palette}
            fonts={fonts}
            title={moment.characterName || t('moments.default.characterName')}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Avatar uri={moment.avatarUri} name={moment.characterName} palette={palette} fonts={fonts} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                  {formatMomentTime(moment.createdAt, t)}
                </span>
                <span style={{ fontSize: fonts.scaled(13), lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {String(moment.text || '')}
                </span>
              </div>
            </div>

            {comments.length > 0 ? (
              <div style={{
                background: palette.surfaceAlt,
                border: `1px solid ${palette.divider}`,
                borderRadius: 8,
                padding: '7px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
              >
                {comments.map((comment, index) => (
                  <div key={comment.id || `comment-${index}`} style={{ fontSize: fonts.scaled(11), lineHeight: 1.6 }}>
                    <span style={{ color: palette.primaryMuted || palette.primary, fontWeight: 700 }}>
                      {comment.author || t('moments.default.characterName')}
                    </span>
                    <span style={{ color: palette.text }}>: {String(comment.text || '')}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <Row>
              <Button
                label={liked ? t('moments.like.unlikeA11y') : t('moments.like.label')}
                onClick={() => toggleLike(moment)}
                palette={palette}
                fonts={fonts}
                primary={liked}
                disabled={busyId === String(moment.id)}
              />
              <Button
                label={t('moments.delete')}
                onClick={() => removeMoment(moment)}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
                disabled={busyId === String(moment.id)}
              />
            </Row>
            <Row>
              <div style={{ flex: 1, minWidth: 180 }}>
                <TextInput
                  value={commentDraft[moment.id] || ''}
                  onChange={value => setCommentDraft(current => ({ ...current, [moment.id]: value }))}
                  placeholder={t('moments.comment.placeholder')}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Button
                label={t('common.save')}
                onClick={() => addComment(moment)}
                palette={palette}
                fonts={fonts}
                disabled={busyId === String(moment.id) || !String(commentDraft[moment.id] || '').trim()}
              />
            </Row>
          </Card>
        );
      })}
    </div>
  );
}