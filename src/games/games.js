// 小游戏清单。每款游戏的 HTML 放在 src/games/html/ 下的独立文件，
// 避免把几十 KB 的 HTML 压成无法 review/diff/lint 的超长单行字符串。
// native 标记的游戏走原生 RN 面板（如 daily-wife 需要读角色库，WebView 拿不到存储）。
//
// 注意：「蛇蛇蛇蛇…」「战机战机…」是**刻意抽象化的名字（规避版权风险），不是占位符**。
// HTML 内的 <title> 与其一致；两处都不要再改回具体作品名，审查时也不必再报。
import GUESS_NUMBER_HTML from './html/GUESS_NUMBER_HTML.js';
import SNAKE_HTML from './html/SNAKE_HTML.js';
import BREAKOUT_HTML from './html/BREAKOUT_HTML.js';
import SNAKE_BATTLE_HTML from './html/SNAKE_BATTLE_HTML.js';
import THUNDER_HTML from './html/THUNDER_HTML.js';

export const GAMES = [
  {
    id: 'guess-number',
    nameKey: 'ext.games.guessNumber.name',
    descriptionKey: 'ext.games.guessNumber.desc',
    html: GUESS_NUMBER_HTML,
  },
  {
    id: 'snake',
    nameKey: 'ext.games.snake.name',
    descriptionKey: 'ext.games.snake.desc',
    html: SNAKE_HTML,
  },
  {
    id: 'breakout',
    nameKey: 'ext.games.breakout.name',
    descriptionKey: 'ext.games.breakout.desc',
    html: BREAKOUT_HTML,
  },
  {
    id: 'snake-battle',
    nameKey: 'ext.games.snakeBattle.name',
    descriptionKey: 'ext.games.snakeBattle.desc',
    html: SNAKE_BATTLE_HTML,
  },
  {
    id: 'thunder-fighter',
    nameKey: 'ext.games.thunderFighter.name',
    descriptionKey: 'ext.games.thunderFighter.desc',
    html: THUNDER_HTML,
  },
  {
    id: 'daily-wife',
    nameKey: 'ext.games.dailyWife.name',
    descriptionKey: 'ext.games.dailyWife.desc',
    native: 'daily-wife',
  },
];
