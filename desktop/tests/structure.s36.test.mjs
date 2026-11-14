// 桌面外壳结构守卫（S36）：清单对照查出的 8 个功能缺口。
//
// 这一轮的做法变了：不再靠「某个维度抽查」，而是把**手机端全部用户可达功能面**
// 与**桌面端全部功能面**各列一份清单逐项对照（149 vs 97），差异逐条核实到文件级。
// 查出的 8 项里，1 项是缺陷（菜单项是死的），7 项是「误判成不可移植」的漏做：
// 它们的判定与数据其实都在共享层，差的只是 DOM 界面。
//
// 本文件钉住两件事：
//   1. 每个缺口确实补上了（入口存在且被上层引用）；
//   2. 补的时候**没有重写判定**——都 import 共享层，而不是在 desktop 里再实现一遍。
//      第 2 点比第 1 点重要：一旦重写，两端行为就会各自漂移，而这是最难发现的一类回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const SETTINGS = read('src', 'settings', 'SettingsScreen.jsx');
const CHATPANE = read('src', 'provider', 'ChatPane.jsx');
const SELECTION = read('src', 'chat', 'useMessageSelection.js');
const MENU = read('src', 'render', 'MessageActionsMenu.jsx');

test('DesktopApp 声明顺序：公告 hook 必须读得到 appVersion（否则整页白屏）', () => {
  // 打包版实测踩到：useStartupAnnouncement({ localVersion: appVersion }) 写在
  // appVersion 的 useState 之前 → TDZ，压缩后报 'Cannot access xe before
  // initialization'，**整页白屏**。而 lint、单测、vite build 全部通过——这类错误
  // 只有真的启动应用才看得见，所以必须在这里钉住。
  const app = read('src', 'provider', 'DesktopApp.jsx');
  const versionAt = app.indexOf("const [appVersion, setAppVersion] = useState('')");
  const hookAt = app.indexOf('useStartupAnnouncement({ localVersion: appVersion })');
  assert.ok(versionAt > 0, '应有 appVersion 状态声明');
  assert.ok(hookAt > 0, '应有公告 hook');
  assert.ok(hookAt > versionAt,
    'useStartupAnnouncement 必须声明在 appVersion 之后（提前引用会 TDZ 白屏）');
  // 同理：cachedAnnouncement / showAnnouncement 也应在同一区块。
  assert.ok(app.indexOf('const cachedAnnouncement') > versionAt, 'cachedAnnouncement 应在之后');
});

test('测试自身的路径基准：read() 不得依赖「在 desktop/ 下运行」', () => {
  // 这一轮发现的第二个盲区：26 个 structure.s*.test.mjs 的 read() 用
  // path.join(...parts)（相对 cwd），而调用点传的是 'src/...'（相对 desktop/）。
  // 在 desktop/ 目录里跑 `npm test` 恰好对；在仓库根跑 `node --test` 则全部
  // ENOENT——于是这些测试长期只在一个目录下有效，根目录的全量测试从未真正
  // 覆盖它们（此前根测试报 5188/5189 的那个失败就是它）。
  //
  // 判据：每个测试文件的 read() 必须显式基于 DESKTOP 或 ROOT，或调用点自带
  // DESKTOP/ROOT 前缀。两种写法都可以，但**不能两者都缺**。
  const files = readdirSync(HERE).filter(name => /^structure\.s\d+b?\.test\.mjs$/.test(name));
  assert.ok(files.length >= 20, `应扫到全部 structure 测试（实际 ${files.length}）`);
  const broken = [];
  files.forEach(name => {
    const source = readFileSync(path.join(HERE, name), 'utf8');
    const defs = [...source.matchAll(/const (read|readRoot) = \(\.\.\.parts\) => readFileSync\(path\.join\(([^)]*)\)/g)];
    if (defs.length === 0) return;
    const readDef = defs.find(match => match[1] === 'read');
    if (!readDef) return;
    const baseIncludesDesktop = /DESKTOP|ROOT/.test(readDef[2]);
    if (baseIncludesDesktop) return;
    // 没在定义里加基准 → 调用点必须自带
    const calls = [...source.matchAll(/(?:const \w+ = )?read\(([^\n]*)\)/g)];
    const allPrefixed = calls.length > 0 && calls.every(match => /^\s*(DESKTOP|ROOT)\s*,/.test(match[1]));
    if (!allPrefixed) broken.push(name);
  });
  assert.deepEqual(broken, [], `这些测试在仓库根目录运行会 ENOENT：${broken.join(', ')}`);
});

test('缺陷修复：删除图片消息不再是死条目', () => {
  // 菜单项只在 onDeleteImageMessage 存在时渲染；此前 ChatPane 从未传它。
  assert.ok(MENU.includes('onDeleteImageMessage'), '菜单应保留该项');
  assert.ok(CHATPANE.includes('onDeleteImageMessage={selection.removeOne}'),
    'ChatPane 必须真的传入，否则菜单项永不出现');
  // 单条删除必须走**同一条编排**，不能另写一份（否则记忆摘要/尾段归档/向量清理会漏）。
  assert.ok(SELECTION.includes('removeOne'), '应有单条删除入口');
  assert.ok(/const executeDeletion = useCallback/.test(SELECTION),
    '单条与批量应共用 executeDeletion');
  assert.ok(/removeSelected[\s\S]{0,600}executeDeletion\(plan\)/.test(SELECTION)
    || SELECTION.split('executeDeletion(plan)').length >= 3,
    '两个入口都应调用同一执行体');
  // 单条删除复用共享词条（与手机同名）。
  assert.ok(SELECTION.includes("'chat.deleteImage.title'"), '应复用手机的删除确认词条');
});

test('今日老婆：复用共享抽取逻辑，不再标成不可用', () => {
  const screen = read('src', 'extension', 'screens', 'DailyWifeScreen.jsx');
  assert.ok(screen.includes('pickDailyCharacter'), '应复用共享 pickDailyCharacter');
  assert.ok(screen.includes('buildDailyDateStr'), '应复用共享日期串');
  // 跨天必须重算：挂载时算一次就冻结会让长期开着的窗口永不换人。
  assert.ok(/visibilitychange/.test(screen), '桌面应以 visibilitychange 触发重算');
  // 加载失败/未加载时不能拿默认角色当「今日老婆」。
  assert.ok(/loaded/.test(screen) && /startupError/.test(screen), '应有 loaded/startupError 判据');
  const games = read('src', 'extension', 'screens', 'GamesScreen.jsx');
  assert.ok(games.includes('DailyWifeScreen'), '游戏页应渲染该面板');
  assert.ok(games.includes("activeGame.native === 'daily-wife'"), '应按 native 标记分派');
});

test('阅读器字号：边界抽到共享叶模块，两端共用', () => {
  const shared = readRoot('src', 'books', 'readerFont.js');
  assert.ok(/FONT_MIN = 13/.test(shared), '共享层应有下限');
  assert.ok(/FONT_MAX = 26/.test(shared), '共享层应有上限');
  assert.ok(/FONT_DEFAULT = 17/.test(shared), '共享层应有默认值');
  // 手机侧必须改为 import 共享，否则两份边界会漂移。
  const mobile = readRoot('src', 'books', 'BookReaderView.js');
  assert.ok(mobile.includes('readerFont.js'), '手机阅读器应 import 共享字号模块');
  assert.ok(!/const FONT_MIN = 13/.test(mobile), '手机不应再保留本地字面量');
  const desktop = read('src', 'extension', 'screens', 'BookReader.jsx');
  assert.ok(desktop.includes('readerFont.js'), '桌面阅读器应 import 同一模块');
  assert.ok(desktop.includes('canGrowFont') && desktop.includes('canShrinkFont'),
    '到边界时按钮应置灰');
});

test('设置搜索：分区映射保证「搜到的都能跳」', () => {
  const index = read('src', 'settings', 'desktopSearchIndex.js');
  assert.ok(index.includes('SETTINGS_SEARCH_INDEX'), '应基于共享索引');
  // 手机有、桌面没有的分区必须丢弃，否则搜出来点进去无处可去。
  assert.ok(/DESKTOP_DROPPED_SECTIONS/.test(index), '应有丢弃表');
  for (const id of ['workspace', 'github', 'mcpservers', 'localmodel']) {
    assert.ok(index.includes(`'${id}'`), `应丢弃手机独有的 ${id} 分区`);
  }
  // 手机归到 extensions 的（自动配图/联网/播报）在桌面属于「对话体验」。
  assert.ok(/extensions: 'experience'/.test(index), '应有分区改归属');
  assert.ok(SETTINGS.includes('searchDesktopSettings'), '设置页应使用该索引');
  assert.ok(SETTINGS.includes('groupDesktopSearchResults'), '结果应按分区聚合');
});

test('自定义配色：复用共享槽位与校验，不另写一份', () => {
  const card = read('src', 'settings', 'CustomThemeCard.jsx');
  assert.ok(card.includes('CUSTOM_COLOR_GROUPS'), '应复用共享分组');
  assert.ok(card.includes('CUSTOM_COLOR_FIELD_KEYS'), '槽位名应走 i18n key');
  assert.ok(card.includes('isValidHexColor'), '应复用共享校验');
  assert.ok(card.includes('resolveCustomColors'), '未改动槽位应显示底稿色');
  // 保存必须走 ThemeContext（内部会 normalize 并切到 custom 主题）。
  assert.ok(card.includes('setCustomColors'), '保存应走 ThemeContext');
  assert.ok(SETTINGS.includes('CustomThemeCard'), '应挂到外观分区');
});

test('语音播报 / 转写：面板存在且复用共享声明', () => {
  const tts = read('src', 'settings', 'TtsCard.jsx');
  assert.ok(tts.includes('TTS_PROVIDERS'), '应复用共享 provider 声明');
  assert.ok(tts.includes('ttsProviderLabel') && tts.includes('ttsFieldLabel'),
    '显示名/字段名应走共享取值函数');
  assert.ok(tts.includes('getTtsSettings') && tts.includes('saveTtsSettings'), '读写走共享');
  // 读坏必须拒绝编辑（拿默认值保存会抹掉用户配置）。
  assert.ok(/loadFailed/.test(tts), '应有读失败态');

  const stt = read('src', 'settings', 'TranscriptionCard.jsx');
  assert.ok(stt.includes('TRANSCRIPTION_API_VENDORS'), '应复用共享厂商预设');
  assert.ok(stt.includes('getTranscriptionSettings') && stt.includes('saveTranscriptionSettings'),
    '读写走共享');
  assert.ok(SETTINGS.includes('TtsCard') && SETTINGS.includes('TranscriptionCard'),
    '两张卡都应挂进设置页');
});

test('云端 TTS 播放器：用 HTMLAudioElement 实现共享层要的最小契约', () => {
  const audio = read('src', 'platform', 'audio.js');
  // 共享层 src/tts/index.js 需要：createAudioPlayer + play/pause/remove +
  // addListener('playbackStatusUpdate') → { remove }，事件带 didJustFinish。
  assert.ok(audio.includes('createAudioPlayer'), '必须导出 createAudioPlayer');
  assert.ok(audio.includes('playbackStatusUpdate'), '必须支持该事件名');
  assert.ok(audio.includes('didJustFinish'), '结束事件必须映射成 didJustFinish');
  assert.ok(/ended/.test(audio), '应监听 ended');
  assert.ok(/remove\(\)/.test(audio), '应提供 remove');
  // 不能再 throw「不支持」：系统引擎一直是好的，两处说法自相矛盾过。
  // 判据看**代码**而不是注释——本文件上方注释里为了解释历史会引用那句旧文案。
  assert.ok(!/throw new Error\('voice playback is not available/.test(audio),
    '不应再 throw 播放不可用');
  // 录音仍不可用，必须如实（capabilities.voiceRecording 为 false）。
  const caps = read('src', 'platform', 'capabilities.js');
  assert.ok(/voiceRecording: false/.test(caps), '录音仍是能力缺失');
  assert.ok(/voicePlayback: true/.test(caps), '播报应标为可用');
});

test('应用内公告：启动静默拉取 + 设置页只读缓存', () => {
  const dialog = read('src', 'settings', 'AnnouncementDialog.jsx');
  assert.ok(dialog.includes('resolveAnnouncement'), '应复用共享判定');
  assert.ok(dialog.includes('readCachedRelease'), '设置页入口只读缓存');
  assert.ok(dialog.includes('setDismissedVersion'), '应支持「不再提示此版本」');
  // 远端 body 是外部输入：必须去 markdown 符号，不直接塞 HTML。
  assert.ok(dialog.includes('markdownToPlainText'), '公告正文应走共享纯文本化');
  // localVersion 为空时不能弹（否则开发环境误报）。
  assert.ok(/if \(!localVersion/.test(dialog), '无版本号时不应弹');
  const app = read('src', 'provider', 'DesktopApp.jsx');
  assert.ok(app.includes('useStartupAnnouncement'), '启动路径应挂公告');
  assert.ok(app.includes('AnnouncementDialog'), '应渲染弹窗');
  assert.ok(SETTINGS.includes('announcement.entry'), '关于卡应有更新说明入口');
});
