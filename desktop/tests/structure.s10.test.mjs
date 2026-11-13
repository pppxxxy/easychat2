// 桌面外壳结构守卫（S10）：顶栏拓扑必须与手机版一致。
//
// 手机版（App.js 的 Tab.Screen）只有五个标签：聊天 / 记忆 / 角色 / 扩展 / 设置。
// 其中「记忆」= 会话列表管理（src/MemoryScreen.js），向量记忆与记忆总结在设置页的
// vector 分区，备份在设置页「关于」里。
//
// 桌面此前把记忆做成了设置页，于是顶栏额外塞了「会话」与「备份与恢复」两个按钮
// ——既与手机版位置不符，也让顶栏出现两个「记忆」。本文件钉住归位后的拓扑：
//   · 顶栏只有五个标签 + 新建会话「+」；
//   · 记忆标签渲染会话列表（不是向量记忆设置）；
//   · 向量记忆/记忆总结在设置页 vector 分区；
//   · 备份入口在设置页，不在顶栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const APP = read(DESKTOP, 'src', 'provider', 'DesktopApp.jsx');
const SETTINGS = read(DESKTOP, 'src', 'settings', 'SettingsScreen.jsx');
const MEMORY_LIST = read(DESKTOP, 'src', 'memory', 'MemoryListScreen.jsx');
const MEMORY_SETTINGS = read(DESKTOP, 'src', 'settings', 'MemorySettingsCard.jsx');
const MOBILE_APP = read(ROOT, 'App.js');
const ROUTES = read(ROOT, 'src', 'navigation', 'routeNames.js');

test('桌面顶栏与手机版同拓扑：五标签 + 新建会话，没有独立「会话」/「备份」按钮', () => {
  // 手机版路由表：聊天 / 记忆 / 角色 / 扩展 / 设置
  for (const key of ['chat', 'memory', 'character', 'extension', 'settings']) {
    assert.ok(ROUTES.includes(`${key}:`), `手机路由表缺 ${key}`);
  }
  // 手机 App.js 实际注册的 Tab.Screen 必须与路由表一致（两侧同源，防止只改一边）。
  const mobileTabs = [...MOBILE_APP.matchAll(/Tab\.Screen name=\{ROUTE_NAMES\.([a-zA-Z]+)\}/g)]
    .map(match => match[1]);
  assert.deepEqual(mobileTabs, ['chat', 'memory', 'character', 'extension', 'settings']);
  // 桌面顶栏标签集合与之一致。
  for (const key of ['chat', 'character', 'memory', 'extension', 'settings']) {
    assert.ok(APP.includes(`id: '${key}', label: t('app.tab.`), `桌面顶栏缺 ${key} 标签`);
  }
  // 曾经抢位的两个按钮必须消失。
  assert.equal(APP.includes("t('app.tab.sessions')"), false, '顶栏不应再有独立「会话」按钮');
  assert.equal(
    /t\('backup\.title'\)/.test(APP),
    false,
    '顶栏不应再有「备份与恢复」按钮（应进设置页）'
  );
  // 新建会话「+」保留（与手机聊天页顶栏的 + 同义）。
  assert.ok(APP.includes("t('chat.session.newChat.title')"), '缺少新建会话入口');
});

test('记忆标签 = 会话列表管理（与手机同定位），不是向量记忆设置页', () => {
  assert.ok(APP.includes("import MemoryListScreen from '../memory/MemoryListScreen.jsx'"));
  assert.ok(APP.includes('<MemoryListScreen'), '记忆标签未渲染会话列表');
  assert.equal(
    APP.includes("import MemoryScreen from '../memory/MemoryScreen.jsx'"),
    false,
    '旧的「记忆=设置页」组件应已不存在'
  );
  // 列表页要有的管理能力（与手机 MemoryScreen 对齐的子集）。
  for (const marker of [
    "t('memory.checkup.title')",      // 记忆体检
    "t('memory.edit')",               // 批量编辑
    "memoryFilterOptions",           // 筛选 chips（labelKey 间接引用）
    "t('chat.session.rename')",       // 重命名
    "t('memory.clone.action')",       // 克隆
    "t('common.delete')",             // 删除
  ]) {
    assert.ok(MEMORY_LIST.includes(marker), `记忆列表缺 ${marker}`);
  }
  // 桌面没有「看屏幕」线程：不应出现该筛选项。
  assert.equal(MEMORY_LIST.includes('screenWatch'), false, '桌面不应提供屏幕对话筛选');
});

test('向量记忆与记忆总结在设置页 vector 分区（与手机 settings/sectionOrder 对齐）', () => {
  assert.ok(SETTINGS.includes("id: 'vector', key: 'settings.vector.title'"), '设置页缺 vector 分区');
  assert.ok(SETTINGS.includes('<MemorySettingsCard'), 'vector 分区未渲染记忆设置');
  assert.ok(SETTINGS.includes('character={character}'), '向量记忆需要当前角色来清空索引');
  // 分区顺序：vector 必须在 experience 之后、about 之前（抄手机 SECTION_RENDER_ORDER）。
  const ids = [...SETTINGS.matchAll(/id: '([a-zA-Z]+)', key:/g)].map(m => m[1]);
  const order = ids.filter(id => ['api', 'experience', 'vector', 'about'].includes(id));
  assert.deepEqual(order, ['api', 'experience', 'vector', 'about']);
  // 记忆设置卡本身要能读写这两组设置。
  assert.ok(MEMORY_SETTINGS.includes('patchMemorySummarySettings'), '缺记忆总结写入');
  assert.ok(MEMORY_SETTINGS.includes('saveVectorMemorySettings'), '缺向量记忆写入');
  assert.ok(MEMORY_SETTINGS.includes('testVectorConnection'), '缺向量连通性测试');
});

test('备份入口在设置页「关于」，由设置页转交宿主', () => {
  assert.ok(SETTINGS.includes("t('settings.about.backup')"), '关于卡缺备份按钮');
  assert.ok(SETTINGS.includes('onBackup'), '设置页未接收备份回调');
  assert.ok(APP.includes('onBackup={() => setShowBackup(true)}'), '宿主未把备份面板接给设置页');
});

test('桌面源码里不再存在死掉的会话侧栏组件', () => {
  // SessionsPanel 已被 MemoryListScreen 取代；若它还在且无人引用，就是死代码。
  let exists = false;
  try {
    read(DESKTOP, 'src', 'provider', 'SessionsPanel.jsx');
    exists = true;
  } catch (error) {
    exists = false;
  }
  assert.equal(exists, false, 'SessionsPanel.jsx 应已删除');
});

test('顶栏「+」真的新建会话（不是复用旧会话）', () => {
  // 回归：ensureCharacterSession 遇到已有会话只返回旧会话，按了「+」等于没反应。
  // 手机版走的是「⋯ → 新对话」→ startNewSession，桌面照它改。
  assert.ok(APP.includes("from '../../../src/storage/sessionList.js'"), '未引入 startNewSession 所在模块');
  assert.ok(APP.includes('startNewSession(activeId)'), '「+」必须调用 startNewSession');
  assert.equal(
    /onClick=\{\(\) => run\('session', \(\) => ensureCharacterSession\(activeId\)\)\}/.test(APP),
    false,
    '不应再用 ensureCharacterSession 冒充新建'
  );
  // 新建后要切过去（否则用户看到的是旧会话，观感仍是「没反应」）。
  assert.ok(APP.includes('switchSession(created.id)'), '新建后未切换到新会话');
  // 与手机一致的二次确认（新建是可感知的破坏性操作，旧对话要留在记忆里）。
  assert.ok(APP.includes("t('chat.session.newChat.bodySingle')"), '缺少新建确认说明');
});
