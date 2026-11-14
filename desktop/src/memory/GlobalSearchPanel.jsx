// 全库搜索（桌面）：跨所有角色/会话搜索聊天记录（对应手机 SearchScreen）。
//
// 手机侧它是记忆页的一个弹层（MemoryScreen 的 searchOpen），桌面上同样挂进记忆页，
// 只是用内嵌面板而不是 Sheet。
//
// 搜索本身复用共享层 storage/sessionMessages/search.js 的 searchMessages：
// · 按会话分批读（每批 8 个）后线性扫描，避免一次把全库拉进内存；
// · 只有 status==='ok' 的会话参与（损坏会话不参与，也不当成空会话）；
// · 结果按 updatedAt 倒序。
// 界面只负责输入、取消、渲染与点击跳转。
import { useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { searchMessages } from '../../../src/storage/sessions.js';
import { useApp } from '../../../src/context/AppContext.js';
import { Button, Card, Row, TextInput } from '../settings/ui.jsx';

export default function GlobalSearchPanel({ open, onClose, palette, fonts, onOpenSession }) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const { characters } = useApp();
  // 搜索结果只带 characterId：角色名要在这里查（手机 SearchScreen 用 characterMap 同一做法）。
  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      if (item && item.id) map.set(String(item.id), item);
    });
    return map;
  }, [characters]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  const run = useCallback(async () => {
    const query = String(keyword || '').trim();
    if (!query || busy) return;
    // 上一条搜索未结束时先取消：结果按请求顺序返回会串味。
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    try {
      const list = await searchMessages(query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults(Array.isArray(list) ? list : []);
      setSearched(true);
    } catch (searchError) {
      if (!searchError || searchError.name !== 'AbortError') {
        setError(t('search.alert.failed.title'));
        setResults([]);
        setSearched(true);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [busy, keyword, t]);

  if (!open) return null;

  const openResult = result => {
    if (!result || typeof onOpenSession !== 'function') return;
    // 结果里带 sessionId：交给宿主做「切角色 + 切会话 + 进聊天页」。
    onOpenSession({ id: result.sessionId, characterId: result.characterId, type: result.sessionType });
    onClose();
  };

  return (
    <Card title={t('search.empty.hint.title')} palette={palette} fonts={fonts}>
      <Row>
        <div style={{ flex: 1, minWidth: 200 }}>
          <TextInput
            value={keyword}
            onChange={setKeyword}
            placeholder={t('search.history.placeholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button
          label={busy ? t('search.action.searching') : t('search.action.search')}
          onClick={run}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy || !String(keyword || '').trim()}
        />
        <Button label={t('common.close')} onClick={onClose} palette={palette} fonts={fonts} />
      </Row>

      {error ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>{error}</div>
      ) : null}

      {!searched && !busy ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {t('search.empty.hint.description')}
        </div>
      ) : null}

      {searched && results.length === 0 && !busy ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {/* 标题 + 说明两层（手机 EmptyState 是同一对）：只有说明会让人不确定
              到底是「没搜到」还是「还在搜」。 */}
          <div style={{ fontWeight: 700, marginBottom: 2 }}>
            {t('search.empty.notFound.title')}
          </div>
          <div>{t('search.empty.notFound.description')}</div>
        </div>
      ) : null}

      {results.length > 0 ? (
        <>
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('search.result.count', { count: results.length })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '42vh', overflow: 'auto' }}>
            {results.map(result => (
              <button
                key={`${result.sessionId}-${result.messageId}`}
                type="button"
                onClick={() => openResult(result)}
                style={{
                  textAlign: 'left',
                  background: 'transparent',
                  color: palette.text,
                  border: `1px solid ${palette.divider}`,
                  borderRadius: 8,
                  padding: '7px 10px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                  {result.sessionType === 'group' && result.sessionName
                    ? result.sessionName
                    : (result.role === 'user'
                      ? t('chat.bubble.me')
                      // 单聊的发言方是角色；角色已删时手机用「角色已删除」明确提示，
                      // 而不是拿「默认助手」当兜底名（那会让人以为消息来自别人）。
                      : (((characterMap.get(String(result.characterId || '')) || {}).name)
                        || t('search.result.missingCharacter')))}
                </span>
                <span style={{
                  fontSize: fonts.scaled(12),
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                >
                  {String(result.text || '').slice(0, 160)}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
}