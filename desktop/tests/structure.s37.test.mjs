// 桌面外壳结构守卫（S37）：清零 PARITY-MATRIX 第 7 节的待补项。
//
// 每一项都遵循同一条纪律：**判定与写入走共享层，桌面只加界面**。
// 这条纪律比「功能看起来有了」更重要——一旦在 desktop 重写一份判定，两端行为
// 就会各自漂移，而这是最难发现的一类回归。所以每个测试都同时断言：
//   ① 入口存在且被上层引用；② 它 import 的是共享模块，不是本地副本。
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

test('待补 1：设置页批量上锁（多选 + 共享 setCharacterLocks）', () => {
  const card = read('src', 'settings', 'CharacterLockCard.jsx');
  // ② 批量写入必须走共享函数（与单个上锁同一份存储布局与守卫）。
  assert.ok(card.includes('setCharacterLocks'), '应 import 共享 setCharacterLocks');
  assert.ok(/selectedIds/.test(card), '应有多选状态');
  assert.ok(/toggleSelectAll/.test(card), '应有全选/全不选');
  // ① 入口存在：工具条按钮 + 应用按钮。
  assert.ok(card.includes('settings.security.bulk.title'), '应有批量上锁入口');
  assert.ok(card.includes('settings.security.bulk.selected'), '应显示已选数量');
  assert.ok(card.includes('settings.security.bulk.next'), '应有「应用」动作');
  // 只允许勾选筛选后可见的角色：否则全选会静默锁住搜索框外的人。
  assert.ok(/visibleIds/.test(card), '勾选范围应限定在筛选结果内');
  // 提示语义照共享层：空串要传 undefined（别清掉用户原有备忘）。
  assert.ok(/hint \? hint : undefined/.test(card), '空提示应传 undefined');
  // 共享侧确实提供批量入口（避免「桌面调了一个不存在的函数」）。
  const security = readRoot('src', 'storage', 'security.js');
  assert.ok(/export function setCharacterLocks\(/.test(security), '共享层应有 setCharacterLocks');
});

test('待补 2：角色详情 → 载入制卡工坊（共享 draftFromCharacter）', () => {
  const edit = read('src', 'character', 'CharacterEditScreen.jsx');
  // ② 草稿映射与状态构造必须用共享实现。
  assert.ok(edit.includes('draftFromCharacter'), '应复用共享 draftFromCharacter');
  assert.ok(edit.includes('createForgeState'), '应复用共享 createForgeState');
  assert.ok(edit.includes('saveCardForge'), '应写共享 cardForge 存储');
  // ① 入口存在，且宿主真的传了导航回调。
  assert.ok(edit.includes('character.detail.forge.entry'), '应有「导入到制卡」按钮');
  assert.ok(edit.includes('character.detail.forge.loadedNote'), '应写引导语（与手机同词条）');
  // 脏表单要给出不同提示（手机 bodyDirty / body 两条）。
  assert.ok(edit.includes('character.detail.forge.bodyDirty'), '脏表单应提示含未保存编辑');
  const app = read('src', 'provider', 'DesktopApp.jsx');
  assert.ok(app.includes('onOpenForge'), '宿主应传 onOpenForge');
  assert.ok(/setExtensionScreenId\('forge'\)/.test(app), '应跳到制卡路由');
  // 共享侧确实导出这两个函数（避免调到不存在的 API）。
  const forge = readRoot('src', 'cardForge', 'forge.js');
  assert.ok(forge.includes('createForgeState') && forge.includes('draftFromCharacter'), '共享 forge 应导出');
});

test('待补 3：角色编辑草稿恢复（共享 save/take/clear）', () => {
  const hook = read('src', 'character', 'useDesktopCharacterDraft.js');
  assert.ok(hook.includes('saveCharacterEditDraft'), '应复用共享保存');
  assert.ok(hook.includes('takeCharacterEditDraft'), '应复用共享「读即取走」');
  assert.ok(hook.includes('clearCharacterEditDraft'), '不脏/保存后应清草稿');
  // 防抖时长与手机一致（800ms）。
  assert.ok(/DRAFT_DEBOUNCE_MS = 800/.test(hook), '防抖应为 800ms');
  // 每个角色只问一次，避免 seed 重跑反复弹框。
  assert.ok(/askedRef/.test(hook), '应记录已询问过的角色');
  const edit = read('src', 'character', 'CharacterEditScreen.jsx');
  assert.ok(edit.includes('useDesktopCharacterDraft'), '编辑页应使用该 hook');
  assert.ok(hook.includes('character.detail.draftFound.title'), '应弹恢复确认（在 hook 内）');
  // 恢复时必须规范化，否则旧草稿缺字段会把 undefined 塞进输入框。
  assert.ok(/buildCharacterFormState\(\{ \.\.\.character, \.\.\.draftFormState \}\)/.test(edit),
    '恢复应经 buildCharacterFormState 规范化');
});

test('待补 4：未保存编辑的 tab 切换拦截（共享 shouldConfirmTabLeave）', () => {
  const edit = read('src', 'character', 'CharacterEditScreen.jsx');
  assert.ok(edit.includes('setCharacterEditGuard'), '编辑页应把脏态注册到共享信箱');
  const app = read('src', 'provider', 'DesktopApp.jsx');
  assert.ok(app.includes('getCharacterEditGuard'), '宿主应读取该信箱');
  assert.ok(app.includes('shouldConfirmTabLeave'), '拦截判定应走共享纯函数');
  // 三个动作齐全（留下 / 直接离开 / 保存并离开）。
  for (const key of ['app.tabLeave.stay', 'app.tabLeave.leave', 'app.tabLeave.saveAndLeave']) {
    assert.ok(app.includes(key), `应有动作：${key}`);
  }
  // 保存失败不能离开。
  assert.ok(app.includes('if (saved) {'), '保存失败应留在原页');
});

test('待补 5：主动消息通知点击跳会话（主进程回传 target，渲染层导航）', () => {
  // 主进程：点击时把 target 原样回传，不解释业务字段。
  const notify = read('electron', 'ipc', 'notify.js');
  assert.ok(notify.includes("'notify:click'"), '应回传 notify:click');
  assert.ok(notify.includes('target'), 'payload 应带 target');
  // preload：暴露订阅接口并返回取消函数。
  const preload = read('electron', 'preload.cjs');
  assert.ok(preload.includes("ipcRenderer.on('notify:click'"), '应订阅该通道');
  assert.ok(/onClick: handler/.test(preload), '应暴露 onClick');
  // 渲染层：主动消息带上目标；宿主订阅并导航。
  const proactive = read('src', 'proactive', 'useProactiveForeground.js');
  assert.ok(proactive.includes('characterId') && proactive.includes('sessionId'), '通知应带跳转目标');
  const app = read('src', 'provider', 'DesktopApp.jsx');
  const jumpHook = read('src', 'provider', 'useDesktopNotificationJump.js');
  assert.ok(jumpHook.includes('notify.onClick'), '应订阅点击（已抽成 hook）');
  assert.ok(app.includes('useDesktopNotificationJump'), '宿主应使用该 hook');
  assert.ok(app.includes('switchSession'), '应切到目标会话');
  assert.ok(app.includes('setPendingTarget'), '应定位到具体消息');
});

test('待补 6：角色导入进度遮罩（阶段文案复用手机词条）', () => {
  const overlay = read('src', 'character', 'ImportOverlay.jsx');
  assert.ok(overlay.includes('character.detail.importStatus.reading'), '应有读取阶段');
  assert.ok(overlay.includes('character.detail.importStatus.saving'), '应有保存阶段');
  assert.ok(overlay.includes('character.detail.importStatus.largeReading'), '大卡应有独立文案');
  assert.ok(overlay.includes('aria-busy'), '无障碍应标忙碌态');
  const app = read('src', 'provider', 'DesktopApp.jsx');
  assert.ok(app.includes('ImportOverlay'), '宿主应渲染遮罩');
  assert.ok(/setImportStatus\(\{ phase: 'saving'/.test(app), '导入时应推进阶段');
  assert.ok(/setImportStatus\(null\)/.test(app), '完成后应清除遮罩');
});

test('待补 7：聊天内语音设置面板（播报 / 全语音模式 / 转写入口）', () => {
  const panel = read('src', 'chat', 'VoiceSettingsPanel.jsx');
  assert.ok(panel.includes('chat.voiceSettings.title'), '应有面板标题');
  assert.ok(panel.includes('chat.voice.broadcast.label'), '应有自动播报开关');
  assert.ok(panel.includes('chat.voiceSettings.fullMode'), '应有全语音模式');
  assert.ok(panel.includes('chat.voiceSettings.transcription'), '应有转写设置入口');
  // 群聊没有单角色 voiceDisplay：整行不显示（与手机 !isGroup 同判据）。
  assert.ok(/isGroup \? null :/.test(panel), '群聊应隐藏全语音模式');
  // voiceDisplay 写回走共享 updateCharacter（规范化在存储层）。
  assert.ok(panel.includes('voiceDisplay'), '应写回 voiceDisplay');
  // 入口接在「更多」菜单里。
  const menu = read('src', 'chat', 'ChatMoreMenu.jsx');
  assert.ok(menu.includes('voice-settings'), '更多菜单应有语音设置入口');
  // ChatPane 只负责挂载（面板集合已抽出，避免再撞行数棘轮）。
  const info = read('src', 'chat', 'ChatInfoPanels.jsx');
  assert.ok(info.includes('VoiceSettingsPanel'), '面板应由 ChatInfoPanels 挂载');
  const pane = read('src', 'provider', 'ChatPane.jsx');
  assert.ok(pane.includes('ChatInfoPanels'), 'ChatPane 应使用该集合');
});

test('待补 8：角色覆盖补上 TTS 与转写两项', () => {
  const card = read('src', 'character', 'CharacterOverrideCard.jsx');
  assert.ok(card.includes('ttsProviderId'), '应有专属 TTS provider 字段');
  assert.ok(card.includes('ttsVoice'), '应有专属音色字段');
  assert.ok(card.includes('transcriptionConfigId'), '应有专属转写配置字段');
  // 选项来自共享声明，不硬编码 provider 列表。
  assert.ok(card.includes('TTS_PROVIDERS'), 'provider 列表应来自共享声明');
  assert.ok(card.includes('getTtsProvider'), '音色候选应随 provider 变');
  assert.ok(card.includes('getTranscriptionSettings'), '转写配置应读共享存储');
  // 保存仍走共享 saveCharacterOverrides（读坏拒绝写）。
  assert.ok(card.includes('saveCharacterOverrides'), '保存应走共享函数');
  const shared = readRoot('src', 'storage', 'characterOverrides.js');
  assert.ok(shared.includes('ttsProviderId') && shared.includes('transcriptionConfigId'),
    '共享层应已支持这三个字段');
});

test('待补 9：真实地图视图（共享 HTML 构建器 + 共享坐标转换）', () => {
  const screen = read('src', 'extension', 'screens', 'RealMapScreen.jsx');
  assert.ok(screen.includes('buildRealMapHtml'), '地图 HTML 应用共享构建器');
  assert.ok(screen.includes('wgs84ToGcj02'), '坐标转换应用共享函数');
  assert.ok(screen.includes('upsertPlace'), '新增/编辑走共享 upsertPlace');
  assert.ok(screen.includes('removePlace'), '删除走共享 removePlace');
  assert.ok(screen.includes('saveLocationSettings'), '保存走共享存储（读坏拒绝写）');
  assert.ok(screen.includes('PLACE_LIMIT'), '上限应来自共享常量');
  assert.ok(/__setMarker|__clearMarker/.test(screen), '应调用地图暴露的标记 API');
  const map = read('src', 'extension', 'screens', 'MapScreen.jsx');
  assert.ok(map.includes('RealMapScreen'), '网格地图页应能切到真实地图');
  assert.ok(map.includes('world.map.real.view.real'), '应有视图切换入口');
});
