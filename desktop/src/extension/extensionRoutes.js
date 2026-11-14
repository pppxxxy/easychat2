// 扩展页的二级路由（桌面）：`/extension` 下按 id 切换子页面。
//
// 手机版用 native-stack（ExtensionStack.js）注册 13 个 Stack.Screen；桌面的等价物
// 就是「一个 id → 一个组件」的表。这里只做派发，不掺业务逻辑：每个子页面自己读存储、
// 自己保存，与手机各面板独立的做法一致。
//
// 尚未实现的入口返回 null，由宿主把「该入口暂时不可用」如实告诉用户——不是静默
// 空白页（空白页会让用户以为点坏了）。
import BooksScreen from './screens/BooksScreen.jsx';
import CardForgeScreen from './screens/CardForgeScreen.jsx';
import DiaryScreen from './screens/DiaryScreen.jsx';
import GamesScreen from './screens/GamesScreen.jsx';
import ImageGenScreen from './screens/ImageGenScreen.jsx';
import MapScreen from './screens/MapScreen.jsx';
import MomentsScreen from './screens/MomentsScreen.jsx';
import MusicScreen from './screens/MusicScreen.jsx';
import ProactiveScreen from './screens/ProactiveScreen.jsx';
import ScheduleScreen from './screens/ScheduleScreen.jsx';
import ScreenWatchScreen from './screens/ScreenWatchScreen.jsx';

export const EXTENSION_ROUTES = Object.freeze({
  forge: CardForgeScreen,
  schedule: ScheduleScreen,
  diary: DiaryScreen,
  moments: MomentsScreen,
  proactive: ProactiveScreen,
  games: GamesScreen,
  music: MusicScreen,
  books: BooksScreen,
  map: MapScreen,
  image: ImageGenScreen,
  screenWatch: ScreenWatchScreen,
});

export const EXTENSION_ROUTE_IDS = Object.freeze(Object.keys(EXTENSION_ROUTES));

export function resolveExtensionRoute(id) {
  return EXTENSION_ROUTES[String(id || '')] || null;
}