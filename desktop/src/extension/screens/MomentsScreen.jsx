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
// 「角色回复我的评论」两条规则（与手机 MomentsView 一致）：
//   · 角色发的动态 + 我评论 → 发帖角色回复我这条（runCharacterMomentReply）；
//   · 我发的动态 + 我回复某条角色评论 → 那个角色接话（runUserMomentComments 的 reply 模式）。
// 两者都交给模块级 startCommentTask：离开动态页也会跑完并写库。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { getMomentsStatus, updateMoments } from '../../../../src/storage/moments.js';
import { flattenCommentThread } from '../../../../src/moments/commentThread.js';
import { startCommentTask } from '../../../../src/moments/commentRunner.js';
import { runUserMomentComments } from '../../../../src/moments/runUserMomentComments.js';
import { runCharacterMomentReply } from '../../../../src/moments/runCharacterMomentReply.js';
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
  // 用户自己发布动态（与手机同一链路：写入 authorType:'user' 的动态，再后台触发角色评论）。
  const [postDraft, setPostDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // 每条动态的「正在回复哪条评论」（空 = 顶层评论）。与手机 MomentsView 的 replyTargets 同语义。
  const [replyTargets, setReplyTargets] = useState({});
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

  // 发布：先落一条用户动态，再后台串行让角色来评论（进度通过重新读库逐步刷新）。
  // 用 startCommentTask 而不是裸 await：用户离开动态页时评论**不会**被组件卸载中止
  // （手机侧 2026-10-11 的同类反馈）。
  const submitPost = async () => {
    const text = String(postDraft || '').trim();
    if (!text || posting) return;
    setPosting(true);
    const momentId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const moment = {
      id: momentId,
      authorType: 'user',
      characterId: '',
      characterName: t('moments.default.userName'),
      avatarUri: '',
      sessionId: '',
      trigger: 'user-post',
      text,
      createdAt: Date.now(),
      likedByUser: false,
      likes: [],
      comments: [],
    };
    try {
      await updateMoments(list => [moment, ...(Array.isArray(list) ? list : [])]);
      setPostDraft('');
      await load();
      startCommentTask(momentId, () => runUserMomentComments({ momentId, onComment: load }));
    } catch (error) {
      Alert.alert(t('moments.alert.postFailed.title'), t('moments.alert.postFailed.body'));
    } finally {
      setPosting(false);
    }
  };

  // 评论（可选：回复某条角色评论）。
  // 形状必须与共享层一致——commentThread 读 replyToId 组线程、读 name 显示说话人，
  // 早先写的 author/byUser 它认不出来，回复会平铺成两条独立评论。
  const addComment = async (moment, replyTarget = null) => {
    const draft = String((commentDraft[moment.id] || '')).trim();
    if (!moment || !draft || busyId) return;
    setBusyId(String(moment.id));
    const targetId = String((replyTarget && replyTarget.id) || '');
    try {
      const comment = {
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        by: 'user',
        characterId: '',
        name: t('moments.default.userName'),
        text: draft,
        createdAt: Date.now(),
        likedByCharacter: false,
        // 空串 = 顶层评论；非空 = 挂在那条评论下（共享层用它组线程）。
        replyToId: targetId,
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
      if (next) {
        // 规则一：角色发的动态 → 发帖角色回复我这条。
        // 规则二：我发的动态 + 我回复了某条角色评论 → 那个角色接话。
        // 顶层评论不触发新一轮群评（发布时已经评过一轮，再跑只会刷屏）——与手机同口径。
        if (next.authorType !== 'user') {
          startCommentTask(moment.id, ({ signal }) => runCharacterMomentReply({
            momentId: moment.id,
            commentId: comment.id,
            signal,
            onComment: load,
            onError: error => {
              const reason = String((error && error.message) || '');
              // 角色已被删除是真实可能的状态，如实说明；其余失败静默（增值功能）。
              if (reason === 'moment-character-missing') {
                Alert.alert(t('moments.alert.noReply.title'), t('moments.alert.noReply.bodyMissing'));
              } else if (reason === 'moment-reply-empty') {
                Alert.alert(t('moments.alert.noReply.title'), t('moments.alert.noReply.bodyRetry'));
              }
            },
          }));
        } else if (targetId && replyTarget && replyTarget.characterId) {
          startCommentTask(moment.id, ({ signal }) => runUserMomentComments({
            momentId: moment.id,
            signal,
            mode: 'reply',
            focusCommentId: comment.id,
            responderIds: [String(replyTarget.characterId)],
            onComment: load,
          }));
        }
      }
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

      <Card title={t('ext.home.moments')} palette={palette} fonts={fonts}>
        <Row>
          <div style={{ flex: 1, minWidth: 200 }}>
            <TextInput
              value={postDraft}
              onChange={setPostDraft}
              placeholder={t('moments.post.placeholder')}
              palette={palette}
              fonts={fonts}
            />
          </div>
          <Button
            label={posting ? t('backup.progress.ratio') : t('moments.post.sendA11y')}
            onClick={submitPost}
            palette={palette}
            fonts={fonts}
            primary
            disabled={posting || !String(postDraft || '').trim()}
          />
        </Row>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('moments.empty.description')}
        </div>
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
                {comments.map((entry, index) => {
                  const comment = entry.comment || entry;
                  const isReply = entry.depth === 1;
                  const name = String(comment.name || '').trim() || t('moments.default.characterName');
                  return (
                    <div
                      key={comment.id || `comment-${index}`}
                      style={{
                        fontSize: fonts.scaled(11),
                        lineHeight: 1.6,
                        // 回复缩进一格（与手机同口径），让「谁答谁」一眼可见。
                        marginLeft: isReply ? 14 : 0,
                        borderLeft: isReply ? `2px solid ${palette.divider}` : 'none',
                        paddingLeft: isReply ? 8 : 0,
                      }}
                    >
                      <span style={{ color: palette.primaryMuted || palette.primary, fontWeight: 700 }}>
                        {name}
                      </span>
                      {isReply && entry.parentName ? (
                        <span style={{ color: palette.textFaint }}>
                          {' '}→ {String(entry.parentName)}
                        </span>
                      ) : null}
                      <span style={{ color: palette.text }}>: {String(comment.text || '')}</span>
                      {/* 回复只能对着角色评论（用户回复自己没意义，也与手机的判定一致）。 */}
                      {!isReply && comment.by === 'character' ? (
                        <button
                          type="button"
                          onClick={() => setReplyTargets(current => ({
                            ...current,
                            [moment.id]: current[moment.id] === String(comment.id) ? null : String(comment.id),
                          }))}
                          style={{
                            marginLeft: 6,
                            background: 'transparent',
                            border: 'none',
                            color: palette.textMuted,
                            cursor: 'pointer',
                            fontSize: fonts.scaled(10),
                            textDecoration: 'underline',
                          }}
                        >
                          {t('moments.comment.replyPlaceholder').replace('…', '')}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
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
                onClick={() => {
                  const targetId = String(replyTargets[moment.id] || '');
                  const target = targetId
                    ? (Array.isArray(moment.comments) ? moment.comments : []).find(item => String(item.id) === targetId)
                    : null;
                  addComment(moment, target || null);
                  // 发出去就清掉回复目标，避免下一条无意间又挂到同一处。
                  setReplyTargets(current => ({ ...current, [moment.id]: null }));
                }}
                palette={palette}
                fonts={fonts}
                primary
                disabled={busyId === String(moment.id) || !String(commentDraft[moment.id] || '').trim()}
              />
            </Row>
          </Card>
        );
      })}
    </div>
  );
}