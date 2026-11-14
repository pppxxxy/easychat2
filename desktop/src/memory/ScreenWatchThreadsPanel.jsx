// 屏幕对话（桌面）：管理「一起看屏幕」产生的对话线程。
//
// 此前桌面**完全没接**这块——共享层 memory/useScreenWatchThreads.js 早就写好了
// 加载 / 三态（读失败 ≠ 没有）/ 删除 / 清空空线程 / 清空全部，手机记忆页也有对应
// 的筛选 chip 与操作，桌面记忆页只列会话，看不到这些线程。
//
// 本组件只做呈现：所有判定与删除语义都在共享 hook 里（含失败必须弹提示的纪律）。
import { useEffect } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import useScreenWatchThreads from '../../../src/memory/useScreenWatchThreads.js';
import { screenThreadPreview } from '../../../src/memory/memoryBuckets.js';
import { Button, Card, Row } from '../settings/ui.jsx';

export default function ScreenWatchThreadsPanel({ palette, fonts }) {
  const { t } = useTranslation();
  const {
    threadsFailed,
    activeThreads,
    emptyThreads,
    reloadThreads,
    handleDeleteThread,
    handleClearEmptyThreads,
    handleClearAllThreads,
  } = useScreenWatchThreads({ t });

  useEffect(() => { reloadThreads(); }, [reloadThreads]);

  return (
    <Card
      title={t('memory.screenWatch.title')}
      hint={t('memory.screenWatch.count', { count: activeThreads.length })}
      palette={palette}
      fonts={fonts}
    >
      {/* 三态：读失败必须如实说，不能渲染成「没有屏幕对话」——那会把异常说成正常。 */}
      {threadsFailed ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700 }}>{t('memory.screenWatch.readFailed.title')}</div>
          <div>{t('memory.screenWatch.readFailed.body')}</div>
        </div>
      ) : null}

      {!threadsFailed && activeThreads.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          <div>{t('memory.screenWatch.empty.title')}</div>
          <div style={{ color: palette.textFaint }}>{t('memory.screenWatch.empty.body')}</div>
        </div>
      ) : null}

      {activeThreads.map(thread => (
        <div
          key={thread.id}
          style={{
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '7px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>
              {String(thread.characterName || '').trim() || t('common.characterFallback')}
            </div>
            <div style={{
              fontSize: fonts.scaled(10),
              color: palette.textFaint,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            >
              {screenThreadPreview(thread) || t('memory.screenWatch.emptyPreview')}
            </div>
          </div>
          <span style={{ fontSize: fonts.scaled(10), color: palette.textMuted }}>
            {t('memory.screenWatch.entries', { count: Array.isArray(thread.entries) ? thread.entries.length : 0 })}
          </span>
          <Button label={t('common.delete')} onClick={() => handleDeleteThread(thread)} palette={palette} fonts={fonts} />
        </div>
      ))}

      <Row>
        {emptyThreads.length > 0 ? (
          <>
            <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
              {t('memory.screenWatch.emptyCount', { count: emptyThreads.length })}
            </span>
            <Button label={t('memory.screenWatch.clear')} onClick={handleClearEmptyThreads} palette={palette} fonts={fonts} />
          </>
        ) : null}
        {activeThreads.length > 0 || emptyThreads.length > 0 ? (
          <Button label={t('memory.screenWatch.clearAll')} onClick={handleClearAllThreads} palette={palette} fonts={fonts} />
        ) : null}
      </Row>
    </Card>
  );
}