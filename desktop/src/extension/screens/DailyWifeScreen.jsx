// 「今日老婆/老公」（桌面）：对应手机 games/DailyWifeView.js。
//
// 判定一行都不重写——抽取逻辑全在共享层 src/games/dailyWife.js（零依赖纯函数）：
//   · buildDailyDateStr() 本地日期串（非 UTC），跨天自动换人；
//   · pickDailyCharacter(characters, dateStr, mode) 按 djb2 hash 稳定取模。
// 桌面这层只做三件平台相关的事：日期跨天刷新（用 visibilitychange 代替 AppState）、
// 以及把 RN 的 View/Text 换成 DOM。
//
// 为什么之前是「点开只给一句说明」：那版把「需要角色库面板」当成了不可移植。
// 实际上角色库数据在共享层 AppContext 里、抽取是纯函数，差的只是 DOM 界面——
// 属于「还没做」，不该写成「做不了」。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  buildDailyDateStr,
  pickDailyCharacter,
} from '../../../../src/games/dailyWife.js';
import { Button } from '../../settings/ui.jsx';

const MODES = ['wife', 'husband'];

export default function DailyWifeScreen({ palette, fonts, onBack }) {
  const { t } = useTranslation();
  const { characters, loaded, startupError } = useApp();
  const [mode, setMode] = useState('wife');

  // 「今日」语义靠日期串。手机侧挂 AppState 监听回前台重算；桌面用 visibilitychange
  // （窗口最小化再回来 / 隔夜挂着），语义等价：**不能在挂载时算一次就冻结**，
  // 否则长期开着的窗口跨天不换人，与 dailyWife.js 的「跨天自动换」矛盾。
  const [dateStr, setDateStr] = useState(() => buildDailyDateStr());
  const refreshDateStr = useCallback(() => {
    setDateStr(current => {
      const next = buildDailyDateStr();
      return next === current ? current : next;
    });
  }, []);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshDateStr();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshDateStr]);

  // 只有「加载完成且没有启动错误」时才参与抽取：失败回落快照是 [DEFAULT_CHARACTER]，
  // 拿它抽取等于把内置助手当成今日老婆（与手机同一处 P2-2 判据）。
  const list = Array.isArray(characters) ? characters : [];
  const pickable = loaded && !startupError && list.length > 0;
  const picked = useMemo(
    () => (pickable ? pickDailyCharacter(list, dateStr, mode) : null),
    [pickable, list, dateStr, mode]
  );

  const isWife = mode === 'wife';
  const emptyTitle = startupError
    ? t('error.storage.characterIndexReadFailed')
    : (!loaded ? t('dailyWife.loading') : t('dailyWife.empty.title'));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderBottom: `1px solid ${palette.divider}`,
        flex: 'none',
      }}
      >
        <Button label={t('dailyWife.back')} onClick={onBack} palette={palette} fonts={fonts} />
        <strong style={{ fontSize: fonts.scaled(14) }}>
          {isWife ? t('dailyWife.title.wife') : t('dailyWife.title.husband')}
        </strong>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {MODES.map(value => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={active}
                style={{
                  background: active ? palette.primary : 'transparent',
                  color: active ? palette.primaryContrast : palette.textMuted,
                  border: `1px solid ${active ? palette.primary : palette.divider}`,
                  borderRadius: 999,
                  padding: '4px 12px',
                  fontSize: fonts.scaled(11),
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                }}
              >
                {value === 'wife' ? t('dailyWife.title.wife') : t('dailyWife.title.husband')}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 24, minWidth: 0 }}>
        {!picked ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '40px 16px',
            color: palette.textMuted,
          }}
          >
            <div style={{ fontSize: fonts.scaled(13), fontWeight: 700, color: palette.text }}>
              {emptyTitle}
            </div>
            {startupError ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
                {String(startupError.body || startupError.title || '')}
              </div>
            ) : null}
            {!startupError && loaded && list.length === 0 ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
                {t('dailyWife.empty.hint')}
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{
            maxWidth: 420,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            background: palette.surface,
            border: `1px solid ${palette.divider}`,
            borderRadius: 14,
            padding: 24,
            textAlign: 'center',
          }}
          >
            {picked.avatarUri ? (
              <img
                src={String(picked.avatarUri)}
                alt=""
                style={{ width: 96, height: 96, borderRadius: 999, objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: 96,
                height: 96,
                borderRadius: 999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: palette.primary,
                color: palette.primaryContrast,
                fontSize: 34,
                fontWeight: 700,
              }}
              >
                {String(picked.name || '?').charAt(0)}
              </div>
            )}
            <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{dateStr}</div>
            <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
              {isWife ? t('dailyWife.today.wife') : t('dailyWife.today.husband')}
            </div>
            <div style={{ fontSize: fonts.scaled(18), fontWeight: 700, color: palette.text }}>
              {picked.name || t('dailyWife.unnamed')}
            </div>
            {String(picked.description || '').trim() ? (
              <div style={{
                fontSize: fonts.scaled(12),
                color: palette.textMuted,
                lineHeight: 1.6,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              >
                {String(picked.description).trim()}
              </div>
            ) : null}
            {String(picked.personality || '').trim() ? (
              <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
                {String(picked.personality).trim()}
              </div>
            ) : null}
            {Array.isArray(picked.tags) && picked.tags.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                {picked.tags.slice(0, 4).map(tag => (
                  <span
                    key={tag}
                    style={{
                      fontSize: fonts.scaled(10),
                      color: palette.textMuted,
                      background: palette.surfaceAlt,
                      border: `1px solid ${palette.divider}`,
                      borderRadius: 999,
                      padding: '2px 8px',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, marginTop: 4 }}>
              {t('dailyWife.tomorrowHint')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
