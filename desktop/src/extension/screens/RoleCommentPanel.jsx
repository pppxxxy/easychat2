// 角色评论（桌面）：音乐/书籍共用的「和角色一起听/读」面板。
//
// 两端共享同一套形状（id / characterId / characterName / text / createdAt / source），
// 只是锚点不同（音乐记 atMs，书籍记 anchor{blockIndex,anchorText,excerpt}）。
// 本组件只负责「选角色 → 拼提示词 → 请求模型 → 追加评论」这一条链路：
//   · 提示词复用 music/commentPrompts 与 books/commentPrompts（不重写措辞）；
//   · 落库复用 appendMusicComment / appendBookComment（含损坏保护与串行队列）；
//   · 读路径的 status 必须是三态：读坏时告诉用户，而不是显示「还没有评论」。
//
// 手机侧还有「播放到打点时自动评论」「按音频/片段上下文评论」，那需要音频解码与
// 打点游标；桌面这版先提供「手动让角色评论当前内容」，这是最常用的入口。
import { useCallback, useEffect, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { getApiConfigs } from '../../../../src/storage/apiConfigs.js';
import { getConfigFingerprint, sendChatMessage } from '../../../../src/network/api.js';
import { appendBookComment, getBookComments } from '../../../../src/books/comments.js';
import { buildPassageCommentPrompt } from '../../../../src/books/commentPrompts.js';
import { appendMusicComment, getMusicComments } from '../../../../src/music/comments.js';
import { buildTriggerCommentPrompt } from '../../../../src/music/commentPrompts.js';
import { Button, Card, Row, Select, TextInput } from '../../settings/ui.jsx';
import { Alert } from '../../platform/alert.js';

function formatAt(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const total = Math.round(value / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function RoleCommentPanel({
  kind,
  target,
  palette,
  fonts,
  onCountChange,
  // 打点触发：播放头跨过某个打点时，宿主把这个位置传进来，面板据此自动生成一条评论。
  // 与手机「播到打点自动评论」同一语义（位置进提示词，见 buildTriggerCommentPrompt）。
  triggerPositionMs = null,
  onTriggerConsumed = null,
}) {
  const { t } = useTranslation();
  const { characters } = useApp();
  const isMusic = kind === 'music';
  const targetId = String((target && (isMusic ? target.id : target.id)) || '');
  const [list, setList] = useState([]);
  const [corrupt, setCorrupt] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (!targetId) return;
    setCorrupt(false);
    try {
      const items = isMusic ? await getMusicComments(targetId) : await getBookComments(targetId);
      setList(Array.isArray(items) ? items : []);
    } catch (error) {
      // 读路径在损坏时会拒绝（不是返回空表）——这里如实提示，绝不显示「还没有评论」。
      setCorrupt(true);
      setList([]);
    }
  }, [isMusic, targetId]);

  useEffect(() => {
    setRoleId((Array.isArray(characters) && characters[0]) ? characters[0].id : '');
  }, [characters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (typeof onCountChange === 'function') onCountChange(list.length); }, [list.length, onCountChange]);

  const ask = async () => {
    const character = (Array.isArray(characters) ? characters : []).find(item => item.id === roleId);
    if (!character || !target || busy) return;
    setBusy(true);
    try {
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));

      // 提示词由共享层按「音乐 / 书籍」各自的上下文构造。
      const prompt = isMusic
        ? buildTriggerCommentPrompt({
          songName: String(target.name || ''),
          positionMs: Number(triggerPositionMs) || 0,
          durationMs: Number(target.durationMs) || 0,
          note: String(note || ''),
        })
        : buildPassageCommentPrompt({
          bookName: String(target.name || ''),
          chapterTitle: '',
          excerpt: String(note || ''),
        });

      const messages = [
        { role: 'system', content: `你是「${character.name || ''}」。按下面的情境，说一句自然的短评，不要旁白。` },
        { role: 'user', content: prompt },
      ];
      const reply = await sendChatMessage(messages, {
        stream: false,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
      });
      const text = String(reply == null ? '' : reply).trim();
      if (!text) throw new Error(t('forge.screen.error.emptyAiReply'));

      // 打点触发成功后清掉，避免同一次触发重复生成（宿主已按 crossed 去重，这里兜底）。
      if (typeof onTriggerConsumed === 'function') onTriggerConsumed();
      const base = {
        id: `c-${Date.now()}`,
        characterId: String(character.id || ''),
        characterName: String(character.name || ''),
        text,
        createdAt: Date.now(),
        source: 'manual',
      };
      // 落库：共享层内部串行入队并在损坏时拒绝写（不会以空表覆盖原评论）。
      if (isMusic) {
        await appendMusicComment(targetId, { ...base, atMs: 0 });
      } else {
        await appendBookComment(targetId, {
          ...base,
          anchor: { blockIndex: 0, anchorText: '', excerpt: String(note || '').slice(0, 120) },
          chapterTitle: '',
        });
      }
      await load();
    } catch (error) {
      Alert.alert(
        t('forge.alert.generateFailed.title'),
        String((error && error.message) || t('forge.alert.generateFailed.bodyRetry'))
      );
    } finally {
      setBusy(false);
    }
  };

  if (!targetId) return null;

  const roleOptions = (Array.isArray(characters) ? characters : []).map(item => ({
    value: item.id,
    label: item.name || t('common.unnamedCharacter'),
  }));

  return (
    <Card
      title={isMusic ? t('music.comments.title') : t('books.comments.title')}
      palette={palette}
      fonts={fonts}
    >
      {corrupt ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {isMusic ? t('music.load.failed.body') : t('books.load.failed.body')}
        </div>
      ) : null}
      {!corrupt && list.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {isMusic ? t('music.comments.empty') : t('books.comments.empty')}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {list.map(comment => (
          <div
            key={comment.id}
            style={{
              fontSize: fonts.scaled(12),
              lineHeight: 1.65,
              borderLeft: `2px solid ${palette.primaryMuted || palette.primary}`,
              paddingLeft: 8,
            }}
          >
            <span style={{ fontWeight: 700, color: palette.textMuted }}>
              {comment.characterName || t('common.unnamedCharacter')}
            </span>
            {comment.atMs ? ` · ${formatAt(comment.atMs)}` : ''}
            {': '}
            {String(comment.text || '')}
          </div>
        ))}
      </div>
      <Row>
        {/* 可选上下文：音乐记「打点说明」，书籍记「摘录/页码」。共享层的提示词会用它。 */}
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextInput
            value={note}
            onChange={setNote}
            placeholder={isMusic ? t('music.player.mark') : t('books.comments.title')}
            palette={palette}
            fonts={fonts}
          />
        </div>
      </Row>
      <Row>
        <Select
          value={roleId}
          options={roleOptions}
          onChange={setRoleId}
          palette={palette}
          fonts={fonts}
          disabled={roleOptions.length === 0 || busy}
        />
        <Button
          label={busy ? t('forge.screen.busy') : t('chat.bubble.generateImage')}
          onClick={ask}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy || !roleId}
        />
      </Row>
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
        {t('desktop.roleComments.hint')}
      </div>
    </Card>
  );
}