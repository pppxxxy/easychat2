// 小游戏清单。每款游戏的 HTML 放在 src/games/html/ 下的独立文件，
// 避免把几十 KB 的 HTML 压成无法 review/diff/lint 的超长单行字符串。
import GUESS_NUMBER_HTML from './html/GUESS_NUMBER_HTML.js';
import SNAKE_HTML from './html/SNAKE_HTML.js';
import BREAKOUT_HTML from './html/BREAKOUT_HTML.js';
import SNAKE_BATTLE_HTML from './html/SNAKE_BATTLE_HTML.js';
import THUNDER_HTML from './html/THUNDER_HTML.js';

export const GAMES = [
  {
    id: 'guess-number',
    name: '猜数字',
    description: '猜出 1 到 100 之间的随机整数，提示偏大或偏小。',
    html: GUESS_NUMBER_HTML,
  },
  {
    id: 'snake',
    name: '贪吃蛇',
    description: '用方向键或触摸滑动控制小蛇吃食物，撞墙或咬到自己结束。',
    html: SNAKE_HTML,
  },
  {
    id: 'breakout',
    name: '打砖块',
    description: '拖动底部挡板反弹小球，击碎砖块并挑战无尽关卡。',
    html: BREAKOUT_HTML,
  },
  {
    id: 'snake-battle',
    name: '蛇蛇蛇蛇蛇蛇蛇蛇',
    description: '单机玩法，控制小蛇成长并挑战更高分数。',
    html: SNAKE_BATTLE_HTML,
  },
  {
    id: 'thunder-fighter',
    name: '战机战机战机战机',
    description: '移动端竖屏射击，躲避弹幕、击落敌机并迎战 BOSS。',
    html: THUNDER_HTML,
  },
];
