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

test('角色锁在「读坏」时选择放行而非锁死（桌面没有换设备的退路）', () => {
  // 手机 SecurityGate 对「状态未知」是上锁处理（可换设备）；桌面如果照抄，
  // 一旦安全存储读失败，用户就再也进不去自己的数据。这里钉住桌面刻意的反向选择。
  assert.ok(
    GATE.includes("isCharacterLocked(characterId).catch(() => false)"),
    '读锁状态失败时应按「未上锁」放行（桌面无换设备退路）'
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