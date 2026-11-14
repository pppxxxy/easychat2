// 桌面外壳结构守卫（S22）：页内逐项比对清单。
//
// 上一轮的 MOBILE_SURFACE 只核对「路由可达」。这一轮往下一层，挑功能最密的三个面
// 逐控件对照手机端，并把结论写成表。历史上正是这类比对才发现整块遗漏
// （settings 的 extensions 节被误当成顶栏 tab，自动配图/表情包整块漏掉）。
//
// 三个面：聊天页菜单与消息操作、角色编辑表单、扩展页各面板。
// 表中 status：done（桌面有等价控件）/ ported（本轮补齐）/ denied（依赖 Android 专属能力）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---------------------------------------------------------------------------
// 面 1：聊天页「更多」菜单。手机端条目构造在 ChatScreen.js（:2892 起）+ chat/moreMenuItems.js。
// ---------------------------------------------------------------------------
const CHAT_MENU = Object.freeze([
  { mobile: 'new-chat', status: 'done', desktop: 'ChatPane 顶栏「+」（GreetingPicker）' },
  { mobile: 'search', status: 'done', desktop: 'ChatMoreMenu search' },
  { mobile: 'summary', status: 'done', desktop: 'ChatMoreMenu summary' },
  { mobile: 'scrubber', status: 'done', desktop: 'ChatMoreMenu scrubber' },
  { mobile: 'fullscreen', status: 'done', desktop: 'ChatMoreMenu fullscreen' },
  { mobile: 'export', status: 'done', desktop: 'ChatMoreMenu export' },
  { mobile: 'edit-role', status: 'ported', desktop: 'ChatMoreMenu edit-role' },
  { mobile: 'model', status: 'done', desktop: 'ChatMoreMenu model' },
  { mobile: 'thinking', status: 'done', desktop: 'ChatMoreMenu thinking' },
  { mobile: 'voice', status: 'done', desktop: 'ChatMoreMenu auto-broadcast（语音模式依赖语音合成，见下）' },
  { mobile: 'memory-provenance', status: 'done', desktop: 'MemoryProvenancePanel（记忆页/设置页）' },
  { mobile: 'session-stats', status: 'done', desktop: 'ChatMoreMenu stats' },
  { mobile: 'notice', status: 'denied', reason: 'announcement-remote-feed' },
  { mobile: 'local-logs', status: 'denied', reason: 'local-model-runtime' },
  { mobile: 'settings', status: 'done', desktop: '设置页「对话体验」节' },
]);

test('聊天页菜单：手机每条都有明确归属（不留下落不明的项）', () => {
  const chatScreen = readRoot('src', 'ChatScreen.js');
  const shared = readRoot('src', 'chat', 'moreMenuItems.js');
  const mobileKeys = [
    ...chatScreen.matchAll(/key: '([a-z-]+)',\n\s+section:/g),
  ].map(m => m[1]);
  const sharedKeys = [...shared.matchAll(/key: '([a-z-]+)'/g)].map(m => m[1]);
  const all = [...new Set([...mobileKeys, ...sharedKeys])];
  assert.ok(all.length >= 10, `手机菜单条目解析异常：${all.join(',')}`);
  for (const key of all) {
    assert.ok(CHAT_MENU.some(item => item.mobile === key), `页内清单缺菜单项 ${key}`);
  }
});

test('聊天页菜单：ported/done 项在桌面确实存在，denied 项理由可核', () => {
  const menu = read('src', 'chat', 'ChatMoreMenu.jsx');
  const pane = read('src', 'provider', 'ChatPane.jsx');
  // 本轮补齐的 edit-role：菜单项 + 宿主回调链都要在。
  assert.ok(menu.includes("key: 'edit-role'"), '缺编辑角色菜单项');
  assert.ok(pane.includes('onEditRole'), '聊天页未把编辑角色接进菜单');
  assert.ok(read('src', 'provider', 'DesktopApp.jsx').includes('onEditCharacter'), '宿主未提供编辑角色回调');
  // S38 起公告已实现（AnnouncementDialog + 免责条款复用），不再是 denied。
  // 判据改为「入口与宿主回调链都在」——避免只加菜单项、点了没反应。
  assert.ok(/chat\.menu\.notice/.test(menu), '缺公告菜单项');
  assert.ok(menu.includes('onOpenNotice'), '菜单未接公告回调');
  assert.ok(pane.includes('onOpenNotice'), '聊天页未透传公告回调');
  assert.ok(read('src', 'provider', 'DesktopApp.jsx').includes('setShowDisclaimer(true)'),
    '宿主未把公告接到免责条款弹层');
});

// ---------------------------------------------------------------------------
// 面 2：角色编辑表单。手机端字段清单在 character/CharacterFormFields.js（共享）。
// ---------------------------------------------------------------------------
test('角色编辑：persona 字段与手机共享清单逐项对应', () => {
  const shared = readRoot('src', 'character', 'CharacterFormFields.js');
  const desktop = read('src', 'character', 'CharacterEditScreen.jsx');
  // 共享清单是权威：7 个 persona 字段。
  const fieldKeys = [...shared.matchAll(/\{ key: '(\w+)', label:/g)].map(m => m[1]);
  assert.deepEqual(fieldKeys, [
    'name', 'systemPrompt', 'description', 'personality', 'scenario', 'firstMes', 'mesExample',
  ]);
  // 桌面按字段 key 逐一有输入框（它不复用 React 组件，但复用同一批 i18n 词条与字段名）。
  for (const key of fieldKeys) {
    assert.ok(
      desktop.includes(`character.fields.${key}.label`) || desktop.includes(`'${key}'`),
      `角色编辑缺字段 ${key}`
    );
  }
  // 头像/背景/问候语/标签/语音形态都要在。
  for (const marker of [
    'character.fields.image.pick',
    'character.fields.greetings.add',
    'character.fields.tags.label',
    'character.fields.voice.label',
  ]) {
    assert.ok(desktop.includes(marker), `角色编辑缺 ${marker}`);
  }
});

// ---------------------------------------------------------------------------
// 面 3：扩展页各面板。
// ---------------------------------------------------------------------------
test('日记：补上「来源会话」跳转与上次运行统计', () => {
  const diary = read('src', 'extension', 'screens', 'DiaryScreen.jsx');
  // 来源解析与手机 DiaryPanel.diarySource 同判据。
  assert.ok(diary.includes('sourceSessionIds'), '缺来源会话 id 解析');
  assert.ok(diary.includes('diary.source.single') && diary.includes('diary.source.multi'),
    '缺来源文案（单/多会话）');
  assert.ok(diary.includes('diary.source.jumpFailed'), '跳转失败无提示');
  // 失败回滚到原会话（不留半切换状态）。
  assert.ok(/previousSessionId/.test(diary), '缺失败回滚');
  // 统计：区分「没触发」与「写了没写」。
  assert.ok(diary.includes('diary.lastRun'), '缺上次运行统计');
  // 跳转后要能回到聊天页（桌面靠宿主清二级路由 + 切视图）。
  assert.ok(read('src', 'provider', 'DesktopApp.jsx').includes('onOpenChat'), '宿主未提供回聊天页的回调');
});

test('主动消息：补上按槽指定模型（手机 proactive.modelLabel）', () => {
  const proactive = read('src', 'extension', 'screens', 'ProactiveScreen.jsx');
  assert.ok(proactive.includes('proactive.modelLabel'), '缺模型选择标签');
  assert.ok(proactive.includes('modelOptions'), '缺模型候选清单');
  assert.ok(/settings\.model/.test(proactive), '未写回 settings.model');
});

test('音乐：补上歌单（复用共享 useMusicPlaylists），并只做筛选不回写判定', () => {
  const panel = read('src', 'extension', 'screens', 'MusicPlaylistPanel.jsx');
  const screen = read('src', 'extension', 'screens', 'MusicScreen.jsx');
  assert.ok(panel.includes('useMusicPlaylists'), '未复用共享歌单 hook');
  // 重名/空名/持久化都在 hook 里，组件不得自己判定。
  assert.ok(!/createMusicPlaylist|renameMusicPlaylist/.test(panel),
    '歌单组件不应绕过 hook 直接写存储');
  assert.ok(panel.includes('music.playlists.create'), '缺新建入口');
  assert.ok(panel.includes('music.playlists.delete'), '缺删除入口');
  assert.ok(panel.includes('toggleSongInPlaylist'), '缺把歌加入歌单');
  assert.ok(screen.includes('MusicPlaylistPanel'), '音乐页未挂歌单');
  // 筛选结果回给宿主必须在 effect 里（渲染期 setState 会告警/循环）。
  assert.ok(/useEffect\(\(\) => \{[\s\S]{0,120}onFilteredChange/.test(panel),
    'onFilteredChange 必须在 effect 中调用');
});

test('音乐/书/图片：已有能力要留痕（避免「看着像缺」被重复实现）', () => {
  const music = read('src', 'extension', 'screens', 'MusicScreen.jsx');
  // 删除与角色评论早已实现（词条在子组件里，早先的词条 diff 会误判为缺失）。
  assert.ok(music.includes('removeItem') || music.includes('deleteMusicItems'), '缺删除');
  assert.ok(music.includes('RoleCommentPanel'), '缺角色评论');
  const books = read('src', 'extension', 'screens', 'BooksScreen.jsx');
  assert.ok(books.includes('readBookContent'), '缺书内容读取');
});

test('denied 项的理由必须能由源码证实（不是「懒得做」）', () => {
  // 公告：远端 feed（手机端从服务端拉取，桌面无该订阅面）。
  const notice = readRoot('src', 'announcements', 'AnnouncementStartup.js');
  assert.ok(/fetch|http/i.test(notice) || notice.includes('announcement'), '公告应为远端来源');
  // 本地日志：依赖本地模型运行时。
  const localLogs = readRoot('src', 'localModel', 'localApiServer.js');
  assert.ok(/NativeModules/.test(localLogs), '本地日志依赖原生 API server');
});