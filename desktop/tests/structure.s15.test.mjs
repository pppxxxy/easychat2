// 桌面外壳结构守卫（S15）：单角色锁必须「设得上 + 拦得住」。
//
// 背景：单角色锁是安全功能。设置页有个输入框不等于锁生效——必须在聊天面板**之前**
// 加一道闸门，否则密码存在 secureStore 里却从来没人校验（手机侧由 SecurityGate
// 在 App 顶层挡住聊天路由）。
//
// 另外这里也钉住「应用锁」为什么不做：它依赖 expo-local-authentication 的生物识别，
// 桌面没有等价硬件入口，界面必须如实说明而不是给一个点了没用的开关。
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
const LOCK_CARD = read(DESKTOP, 'src', 'settings', 'CharacterLockCard.jsx');
const GATE = read(DESKTOP, 'src', 'settings', 'RoleLockGate.jsx');
const MOBILE_ORDER = read(ROOT, 'src', 'settings', 'sectionOrder.js');
const SECURITY_STORE = read(ROOT, 'src', 'storage', 'security.js');

test('设置页有「隐私与安全」分区，位置与手机一致（security 在 autoBackup 之前）', () => {
  assert.ok(MOBILE_ORDER.includes("'security'"), '手机侧安全分区不存在了，请复核');
  const ids = [...SETTINGS.matchAll(/id: '([a-zA-Z]+)', key:/g)].map(m => m[1]);
  assert.ok(ids.includes('security'), '桌面设置页缺 security 分区');
  assert.ok(
    ids.indexOf('security') < ids.indexOf('autoBackup'),
    'security 必须在 autoBackup 之前（手机顺序 security → autoBackup）'
  );
  assert.ok(SETTINGS.includes('<CharacterLockCard'), 'security 分区未渲染角色锁卡片');
});

test('角色锁复用共享层存储，不自己存密码', () => {
  assert.ok(LOCK_CARD.includes("from '../../../src/storage/security.js'"), '未复用共享安全存储');
  assert.ok(LOCK_CARD.includes('setCharacterLock'), '缺上锁入口');
  assert.ok(LOCK_CARD.includes('removeCharacterLock'), '缺移除入口');
  // 密码绝不能进 AsyncStorage（共享层用 secureStore，桌面映射到 safeStorage）。
  assert.equal(
    /AsyncStorage\.setItem/.test(LOCK_CARD),
    false,
    '角色锁卡片不应直接写 AsyncStorage（密码必须走安全存储）'
  );
  // 共享层本身必须把密码写进 safe storage（前提校验）。
  assert.ok(SECURITY_STORE.includes('writeSecureValue(LOCK_SECURE_PREFIX'), '共享层密码存储方式变了，请复核');
});

test('聊天面板前有解锁闸门（不是只有设置页）', () => {
  assert.ok(APP.includes("import RoleLockGate from '../settings/RoleLockGate.jsx'"), '未引入解锁闸门');
  assert.ok(APP.includes('<RoleLockGate'), '聊天面板未被闸门包裹');
  // 闸门必须包住 ChatPane（而不是包住整个 App 或别的地方）。
  const gateIndex = APP.indexOf('<RoleLockGate');
  const chatIndex = APP.indexOf('<ChatPane', gateIndex);
  assert.ok(chatIndex > gateIndex, 'RoleLockGate 必须包住 ChatPane');
  // 校验走共享层的常数时间比较实现。
  assert.ok(GATE.includes('verifyCharacterPasscode'), '闸门未调用共享层校验');
  assert.ok(GATE.includes('isCharacterLocked'), '闸门未查上锁名单');
});

test('角色锁在「读坏」时不再静默放行（S39 修正）', () => {
  // 旧实现用 isCharacterLocked().catch(() => false)：数据损坏时静默当成「没上锁」，
  // 锁形同虚设。现在改为状态感知：未知态**阻挡**，给「重新读取」与一次**显式**继续
  // （桌面没有生物识别这把备用钥匙，所以保留显式继续，而不是纯 fail-closed）。
  assert.ok(GATE.includes('getSecuritySettings'), '应读取带 status 的完整设置');
  assert.ok(GATE.includes('SECURITY_STATUS'), '应区分 ok/missing/unknown');
  assert.ok(GATE.includes('unknownAcknowledged'), '未知态应要求显式确认');
  assert.ok(!/isCharacterLocked\(characterId\)\.catch/.test(GATE), '不应再静默 catch 成 false');
});

test('全局文本预设：开关复用共享存储，且真的会进提示词', () => {
  const card = read(DESKTOP, 'src', 'settings', 'GlobalPresetCard.jsx');
  assert.ok(card.includes("from '../../../src/storage/globalPresets.js'"), '未复用共享预设存储');
  assert.ok(card.includes('saveGlobalPresetSettings'), '缺开关写入口');
  // 真正的生效路径在共享层（useChatSend 读 getEnabledGlobalPresetPrompts）：
  // 桌面只要把开关写进同一份存储，行为就与手机一致。这条断言钉住「同一个入口」。
  const send = read(ROOT, 'src', 'chat', 'useChatSend.js');
  assert.ok(send.includes('getEnabledGlobalPresetPrompts'), '发送链路未读取全局预设（桌面开关会失效）');
});

test('全库搜索复用共享 searchMessages（不自己扫存储）', () => {
  const panel = read(DESKTOP, 'src', 'memory', 'GlobalSearchPanel.jsx');
  assert.ok(panel.includes("from '../../../src/storage/sessions.js'"), '未复用共享搜索入口');
  assert.ok(panel.includes('searchMessages'), '缺全库搜索调用');
  assert.equal(
    /getMessagesBySessionStatus|getSessions\(/.test(panel),
    false,
    '搜索面板不应自己遍历会话（分批读取与损坏过滤在共享层）'
  );
});

test('应用锁如实说明桌面不支持（不提供点了没用的开关）', () => {
  assert.ok(LOCK_CARD.includes("t('desktop.security.appLockUnsupported')"), '缺应用锁差异说明');
  // 不能出现一个「开启应用锁」的开关（desktop localAuth shim 恒为 false）。
  assert.equal(
    /t\('settings\.security\.appLock'\)/.test(LOCK_CARD),
    false,
    '桌面不应渲染应用锁开关'
  );
});