// 小游戏（桌面）：5 款 Web 游戏 + 「每日妻子」原生面板。
//
// 与手机 GamesView 同一份清单（games/games.js 的 GAMES）与同一套 i18n。
// 平台差异只有「装游戏的壳」：
//   · 手机用 react-native-webview 加载 HTML 字符串；
//   · 桌面用 <iframe srcDoc>（渲染进程就是 Chromium，srcDoc 天然支持），
//     并保留 sandbox 属性——游戏页是第三方风格的 HTML，不该拿到父页面上下文
//     （不能读 window.easychat2、不能动存储）。手机侧靠 WebView 的默认隔离达到同样效果。
//
// 「每日妻子」依赖角色库数据，手机走原生面板 DailyWifeView。桌面**同样有角色库**
// （共享 AppContext）且抽取是纯函数（games/dailyWife.js），所以这里直接渲染
// DailyWifeScreen——此前标成「需要角色库面板」是误判：那属于「还没做」，
// 不是「做不了」。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { GAMES } from '../../../../src/games/games.js';
import { Button, Card } from '../../settings/ui.jsx';
import DailyWifeScreen from './DailyWifeScreen.jsx';

export default function GamesScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [activeGameId, setActiveGameId] = useState('');

  const activeGame = useMemo(
    () => GAMES.find(game => game.id === activeGameId) || null,
    [activeGameId]
  );
  const webGames = useMemo(() => GAMES.filter(game => !game.native), []);
  const nativeGames = useMemo(() => GAMES.filter(game => game.native), []);

  const gameCard = (game, unavailable) => (
    <button
      key={game.id}
      type="button"
      onClick={() => {
        if (unavailable) return;
        setActiveGameId(game.id);
      }}
      style={{
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        background: palette.surface,
        color: palette.text,
        border: `1px solid ${palette.divider}`,
        borderRadius: 10,
        padding: '10px 12px',
        cursor: unavailable ? 'default' : 'pointer',
        opacity: unavailable ? 0.65 : 1,
      }}
    >
      <span style={{
        width: 34,
        height: 34,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 9,
        background: palette.primary,
        color: palette.primaryContrast,
        fontSize: 16,
      }}
      >
        🎮
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: fonts.scaled(13), fontWeight: 700 }}>{t(game.nameKey)}</span>
        <span style={{
          fontSize: fonts.scaled(11),
          color: palette.textFaint,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        >
          {t(game.descriptionKey)}
        </span>
      </span>
      {unavailable ? (
        <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint, flex: 'none' }}>
          {t('ext.games.env.title')}
        </span>
      ) : null}
    </button>
  );

  if (activeGame && activeGame.native === 'daily-wife') {
    return <DailyWifeScreen palette={palette} fonts={fonts} onBack={() => setActiveGameId('')} />;
  }

  if (activeGame) {
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
          <Button label={t('ext.games.back')} onClick={() => setActiveGameId('')} palette={palette} fonts={fonts} />
          <strong style={{ fontSize: fonts.scaled(14) }}>{t(activeGame.nameKey)}</strong>
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t(activeGame.descriptionKey)}</span>
        </div>
        <iframe
          // 每次进不同游戏都换 key，避免上一个游戏的定时器/状态留在文档里。
          key={activeGame.id}
          title={t(activeGame.nameKey)}
          srcDoc={activeGame.html}
          // 不给 allow-same-origin：游戏页无法读父页面存储与 bridge；
          // 但需要 allow-scripts（游戏逻辑本身）与 allow-pointer-lock（FPS 类）。
          sandbox="allow-scripts allow-pointer-lock allow-forms"
          style={{ flex: 1, width: '100%', border: 'none', background: '#000' }}
        />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.games.section.web')} palette={palette} fonts={fonts}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {webGames.map(game => gameCard(game, false))}
        </div>
      </Card>
      {nativeGames.length > 0 ? (
        <Card
          title={t('ext.games.section.native')}
          hint={t('desktop.games.nativeHint')}
          palette={palette}
          fonts={fonts}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {nativeGames.map(game => gameCard(game, false))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}