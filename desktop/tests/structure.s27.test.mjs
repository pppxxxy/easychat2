// 桌面外壳结构守卫（S27）：设置页 12 个分区的逐控件比对。
//
// 此前只验过「分区可达」。本轮逐分区核对内部控件，查出 3 处真缺口：
//   1. **聊天内工具（联网搜索/抓取）**——`chatOptions.chatTools` 在共享层已完整支持
//      （useChatSend 读它 → registerChatTools），桌面却没有开关，用户无法开启。
//      注意它是**聊天主路径**能力，不是 agent 工具域。
//   2. **动态总开关**——`moments.enabled` 桌面无 UI（扩展页入口据此变灰）。
//   3. **自动备份的 onExit 说明**——开关本身在，但缺「桌面映射为窗口隐藏」这句解释，
//      用户会按手机语义（切后台）理解。
//
// 其余分区经核对**已对齐或属平台差异**：
//   · api/sampling/persona/appearance：控件齐全（词条名不同）；
//   · vector：卡片与测试/保存都在；缺的 3 条只是「未配置」占位文案；
//   · security：角色锁有；**应用锁只接受生物识别**（手机端唯一解锁路径），
//     桌面无生物识别 ⇒ 开启即无路可进，故诚实不提供（已有明确文案）；
//   · autoBackup：folder.* 是 Android SAF（不可移植）；
//            interval.custom 词条两端都无人使用（预留，非缺口）；
//   · about/diagnostics：版本、教程、免责、诊断、备份入口都在。
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

const SETTINGS = read('src', 'settings', 'SettingsScreen.jsx');
const CHAT_OPTIONS = read('src', 'settings', 'ChatOptionsCard.jsx');
const BACKUP_CARD = read('src', 'settings', 'AutoBackupCard.jsx');
const LOCK_CARD = read('src', 'settings', 'CharacterLockCard.jsx');
const MOMENTS = read('src', 'extension', 'screens', 'MomentsScreen.jsx');
const MEMORY_CARD = read('src', 'settings', 'MemorySettingsCard.jsx');

// ---------------------------------------------------------------------------
// 分区清单：手机 SECTION_RENDER_ORDER 为权威 → 桌面结论
// ---------------------------------------------------------------------------
const SETTINGS_SECTIONS = Object.freeze([
  { id: 'api', status: 'done' },
  { id: 'sampling', status: 'done' },
  { id: 'persona', status: 'done' },
  { id: 'appearance', status: 'done' },
  { id: 'experience', status: 'ported', note: '本轮补 chatTools + 动态总开关' },
  { id: 'vector', status: 'done' },
  { id: 'security', status: 'partial', note: '角色锁可用；应用锁需生物识别，桌面无' },
  { id: 'autoBackup', status: 'partial', note: 'folder.* 为 Android SAF；补 onExit 说明' },
  { id: 'language', status: 'done', note: '语言切换在「外观」卡内' },
  { id: 'about', status: 'done' },
  // 以下三项在手机是独立分区，桌面已判定为不可移植（见 unsupportedReasons）
  { id: 'extensions', status: 'done', note: '已拆入「对话体验」+ 扩展页' },
  { id: 'workspace', status: 'denied', reason: 'workspace-tools' },
  { id: 'github', status: 'denied', reason: 'workspace-tools' },
  { id: 'mcpservers', status: 'denied', reason: 'mcp' },
  { id: 'localmodel', status: 'denied', reason: 'local-models' },
]);

test('设置分区与手机的 SECTION_RENDER_ORDER 对应（缺项只能是被判不可移植的）', () => {
  const order = readRoot('src', 'settings', 'sectionOrder.js');
  const mobileIds = [...order.matchAll(/^  '([a-zA-Z]+)',$/gm)].map(m => m[1]);
  assert.ok(mobileIds.length >= 12, `手机分区解析异常：${mobileIds.length}`);
  for (const id of mobileIds) {
    assert.ok(SETTINGS_SECTIONS.some(item => item.id === id), `页内清单缺分区 ${id}`);
  }
  // denied 的必须是已判不可移植的那几项（agent / 原生域）。
  const denied = SETTINGS_SECTIONS.filter(item => item.status === 'denied').map(item => item.id);
  assert.deepEqual(denied.sort(), ['github', 'localmodel', 'mcpservers', 'workspace'].sort());
});

test('体验分区：补齐「聊天内工具」开关（chatOptions.chatTools 共享层早已支持）', () => {
  assert.ok(CHAT_OPTIONS.includes("options.chatTools === true"), '缺 chatTools 读值');
  assert.ok(/patch\(\{ chatTools: /.test(CHAT_OPTIONS), '缺 chatTools 写回');
  assert.ok(CHAT_OPTIONS.includes('settings.global.chatTools'), '缺标签');
  // 「数据外发」警示必须完整保留（安全相关文案，不能简化掉）。
  assert.ok(CHAT_OPTIONS.includes('settings.global.chatToolsHint'), '缺数据外发说明');
  // 共享层确实在聊天主路径消费它（不是 agent loop）。
  const send = readRoot('src', 'chat', 'useChatSend.js');
  assert.ok(/chatOptionsForTools\.chatTools === true/.test(send), '共享层应读 chatOptions.chatTools');
  assert.ok(send.includes('registerChatTools'), '共享层应据它注册聊天工具');
});

test('动态总开关：moments.enabled 有 UI（扩展页入口据此变灰）', () => {
  assert.ok(MOMENTS.includes('settings.global.moments'), '缺动态总开关标签');
  assert.ok(MOMENTS.includes('saveMomentsSettings'), '缺写回');
  assert.ok(MOMENTS.includes('getMomentsSettings'), '缺读取');
  // 读失败不显示假开关（settings 为 null 时不渲染）。
  assert.ok(/settings \? \(/.test(MOMENTS), 'settings 未加载时不应渲染开关');
});

test('自动备份：onExit 要有平台映射说明（手机是「切后台」，桌面是「窗口隐藏」）', () => {
  assert.ok(BACKUP_CARD.includes('settings.autoBackup.onExitHint'), '缺 onExit 说明');
  assert.ok(BACKUP_CARD.includes('settings.autoBackup.onExit'), '缺 onExit 开关');
  // 桌面自己的差异说明仍在（应用私有目录 / 无目录授权）。
  assert.ok(BACKUP_CARD.includes('desktop.autoBackup.hint'), '缺桌面差异说明');
});

test('安全分区：应用锁诚实不提供，理由必须准确（无生物识别 ⇒ 开了就进不去）', () => {
  // 手机端应用锁**只有生物识别**一条解锁路径（SecurityGate 的 runAppUnlock）。
  const gate = readRoot('src', 'security', 'SecurityGate.js');
  assert.ok(gate.includes('authenticateBiometric'), '手机应用锁应只走生物识别');
  assert.ok(!/verifyAppPin|appPasscode/.test(gate), '手机应用锁不应有 PIN 备选（如有，结论需复核）');
  // 桌面 localAuth 全部不可用 ⇒ 开启即锁死，所以不提供。
  const localAuth = read('src', 'platform', 'localAuth.js');
  assert.ok(/hasHardwareAsync = async \(\) => false/.test(localAuth), '桌面应无生物识别硬件');
  assert.ok(LOCK_CARD.includes('desktop.security.appLockUnsupported'), '缺「不提供应用锁」的说明');
  // 角色锁（自设数字密码）与平台无关，必须在。
  assert.ok(LOCK_CARD.includes('settings.security.appLockPrompt'), '缺角色锁密码入口');
  assert.ok(LOCK_CARD.includes('settings.security.searchPlaceholder'), '缺角色锁搜索');
});

test('向理分区：卡片在，且缺的三条只是「未配置」占位文案', () => {
  assert.ok(MEMORY_CARD.includes('getVectorMemorySettings'), '缺向量设置读取');
  assert.ok(MEMORY_CARD.includes('saveVectorMemorySettings'), '缺向量设置写回');
  // 占位文案：手机用它显示「未填地址 / 未填模型」。桌面缺，但不影响功能；
  // 这条断言记录该判断，避免下一轮把它当功能缺口重复实现。
  const vector = readRoot('src', 'settings', 'sections', 'VectorSection.js');
  assert.ok(vector.includes('settings.api.noAddress'), '手机端应仍用占位文案（基准漂移请复核）');
});

test('关于/诊断：版本、教程、免责、诊断、备份入口都在', () => {
  for (const key of ['settings.about.version', 'diagnostics.title']) {
    assert.ok(SETTINGS.includes(key), `缺 ${key}`);
  }
  // 教程/免责是首启门禁的两个弹层，必须可从关于页重看。
  assert.ok(SETTINGS.includes('onTutorial'), '缺教程重看入口');
  assert.ok(SETTINGS.includes('onDisclaimer'), '缺免责重看入口');
});