// 桌面外壳结构守卫（S16）：本轮补齐的六项功能都要「接得上 + 复用共享层」。
//
// 这些都不是新能力，而是手机已有、桌面缺入口的面：
//   预设条目编辑 / 全屏输入 / 定位条 / 多选删除 / 模型思考切换 / 记忆溯源 / 制卡辅助。
// 判据只针对**接线与复用**：具体判定都在共享层，由各自的单测/集成测试覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const PANE = read(DESKTOP, 'src', 'provider', 'ChatPane.jsx');
const MENU = read(DESKTOP, 'src', 'chat', 'ChatMoreMenu.jsx');
const PRESET = read(DESKTOP, 'src', 'settings', 'GlobalPresetCard.jsx');
const FULLSCREEN = read(DESKTOP, 'src', 'chat', 'FullScreenInput.jsx');
const SELECTION = read(DESKTOP, 'src', 'chat', 'useMessageSelection.js');
const PLAN = read(DESKTOP, 'src', 'chat', 'messageDeletionPlan.js');
const SCRUBBER_HOOK = read(DESKTOP, 'src', 'chat', 'useDesktopScrubber.js');
const MODEL = read(DESKTOP, 'src', 'chat', 'useDesktopModelThinking.js');
const PROVENANCE = read(DESKTOP, 'src', 'memory', 'MemoryProvenancePanel.jsx');
const ASSIST = read(DESKTOP, 'src', 'extension', 'screens', 'forgeAssist.jsx');
const COMMENTS = read(DESKTOP, 'src', 'extension', 'screens', 'RoleCommentPanel.jsx');

test('预设条目：新增/编辑/删除都走共享存储，删除用「重读→过滤→写回」', () => {
  assert.ok(PRESET.includes('createGlobalPresetId'), '缺 id 生成（新条目会撞 id）');
  assert.ok(PRESET.includes('saveGlobalPresets'), '缺写入');
  // 删除必须重读：用界面快照拼列表会覆盖别处（手机端/另一窗口）的改动。
  assert.ok(/getGlobalPresets\(\)\)\.filter/.test(PRESET), '删除未重读当前列表');
  // 新增/编辑共用同一表单提交路径。
  assert.ok(PRESET.includes('preset.editor.editTitle'), '缺编辑入口');
  assert.ok(PRESET.includes('preset.a11y.delete'), '缺删除入口');
});

test('全屏输入复用同一个 input store，而不是第二份草稿', () => {
  // 值由宿主的 input（useInput）提供，onChange 写回同处。
  assert.ok(PANE.includes('<FullScreenInput'), '未挂载全屏输入');
  assert.ok(PANE.includes('value={input}'), '全屏输入未共用 input store');
  assert.ok(FULLSCREEN.includes('onSend'), '缺发送回调');
  // 发送必须走宿主 submit（含开场白拦截/附件校验/会话守卫）。
  // 弹层开关已聚合成 overlays（closeOverlay），但发送仍必须走宿主 submit。
  assert.ok(/onSend=\{\(\) => \{[^}]*submit\(\); \}\}/.test(PANE), '发送未走宿主 submit');
});

test('多选删除：计划由纯模块算出，界面按计划执行', () => {
  assert.ok(PLAN.includes('getContinuousTailPlan'), '未复用「连续尾段」判定');
  assert.ok(PLAN.includes('removeMessagesByIds'), '未复用共享删除');
  assert.ok(SELECTION.includes('planMessageDeletion'), 'hook 未使用删除计划');
  assert.ok(SELECTION.includes('invalidateHistorySummaries'), '缺记忆摘要失效');
  assert.ok(SELECTION.includes('archiveBranch'), '缺连续尾段归档');
  assert.ok(SELECTION.includes('removeVectorIndexForSession'), '缺向量整段清理');
  assert.ok(SELECTION.includes('setSessionGreetingSelected'), '删光时未重置开场白选择');
});

test('定位条复用共享预览缓存，且菜单里有入口', () => {
  assert.ok(SCRUBBER_HOOK.includes('buildScrubberPreview'), '未复用共享预览缓存（流式会逐帧重算）');
  assert.ok(PANE.includes('<ScrollScrubber'), '定位条未挂载');
  assert.ok(MENU.includes("t('chat.menu.scrubber')"), '菜单缺定位入口');
});

test('模型/思考切换：写回共享配置，且发送中禁用', () => {
  assert.ok(MODEL.includes('saveApiConfigs'), '未写回 API 配置');
  assert.ok(MODEL.includes('saveThinkingSettings'), '未写回思考设置');
  // 思考能力必须按**当前模型**解析（同一配置下每模型一套能力）。
  assert.ok(MODEL.includes('capabilitiesForModel'), '未按当前模型解析思考能力');
  assert.ok(MODEL.includes('sendLockRef'), '缺发送中守卫');
  assert.ok(MENU.includes("t('chat.menu.model')"), '菜单缺模型入口');
  assert.ok(MENU.includes("t('chat.menu.thinking')"), '菜单缺思考入口');
});

test('记忆溯源：三态读，读坏不得渲染成「没有记忆」', () => {
  assert.ok(PROVENANCE.includes('getVectorIndexStatus'), '未复用三态索引读取');
  assert.ok(PROVENANCE.includes('buildEvidenceChain'), '未复用证据链');
  assert.ok(PROVENANCE.includes('groupMemoriesBySession'), '未复用分组');
  // corrupt 必须单独渲染说明，而不是当成空列表。
  assert.ok(PROVENANCE.includes('corrupt') && PROVENANCE.includes('memory.provenance.corrupt.body'), '损坏态未单独说明');
  // 源消息对不上时要如实说「已不在」。
  assert.ok(PROVENANCE.includes('chain.found'), '未区分「找到源消息」与「源消息已不在」');
});

test('制卡辅助：字段改写与模拟对话都复用共享提示词/请求', () => {
  assert.ok(ASSIST.includes('buildFieldAssistPrompt'), '未复用字段辅助提示词');
  assert.ok(ASSIST.includes('parseFieldAssistText'), '未复用解析');
  assert.ok(ASSIST.includes('useForgeRequests'), '未复用共享请求封装');
  assert.ok(ASSIST.includes('simulateChat'), '缺模拟对话');
  // 模拟对话只读：不得写会话或角色库。
  assert.equal(/AsyncStorage|saveCharacter|saveCardForge/.test(ASSIST), false, '模拟对话不应写任何存储');
});

test('角色评论的评论形状与共享层 normalize 一致（不自己编字段）', () => {
  // 共享层 normalizeMusicComment / normalizeBookComment 是唯一形状来源；
  // 桌面追加的评论必须带 characterId / characterName / text / source 四件套。
  const musicComments = readFileSync(path.join(ROOT, 'src', 'music', 'comments.js'), 'utf8');
  const bookComments = readFileSync(path.join(ROOT, 'src', 'books', 'comments.js'), 'utf8');
  // 共享层的字段带类型前缀（`characterId: String(...)`），这里只断言属性名出现。
  for (const source of [musicComments, bookComments]) {
    for (const field of ['characterId', 'characterName', 'text', 'source']) {
      assert.ok(source.includes(field), `共享层评论形状缺 ${field}`);
    }
  }
  // 桌面追加评论时四个字段都要带（缺 source 会让共享层回落成 manual，看似无害但会丢语义）。
  for (const field of ['characterId', 'characterName', 'text', 'source']) {
    assert.ok(COMMENTS.includes(field), `桌面追加的评论缺 ${field}`);
  }
});

test('群聊发言方式：开关写回共享存储，且与发送链路的判据一致', () => {
  const dialog = read(DESKTOP, 'src', 'group', 'GroupSettingsPanel.jsx');
  assert.ok(dialog.includes('setGroupMode'), '群聊设置未接发言方式写入');
  assert.ok(dialog.includes("t('group.mode.ensemble')"), '缺合议选项');
  assert.ok(dialog.includes("t('group.mode.turn')"), '缺轮流选项');
  // 发送链路读的字段必须与写入的一致（否则开关是摆设）。
  const send = read(ROOT, 'src', 'chat', 'useChatSend.js');
  assert.ok(send.includes('activeSessionRef.current?.groupMode'), '发送链路未读 groupMode');
  // 存储入口存在且是独立函数（不混进 updateSessionInfo 的三个展示字段）。
  const mutations = read(ROOT, 'src', 'storage', 'sessionList', 'mutations.js');
  assert.ok(mutations.includes('export function setGroupMode'), '共享层缺 setGroupMode');
  assert.equal(
    /updateSessionInfoInternal[\s\S]{0,600}groupMode/.test(mutations),
    false,
    'groupMode 不应被塞进 updateSessionInfo（展示字段与发言机制混在一条写路径）'
  );
});

test('制卡「按图片生成」：走识图能力判定 + 共享提示词', () => {
  const forge = read(DESKTOP, 'src', 'extension', 'screens', 'CardForgeScreen.jsx');
  assert.ok(forge.includes('buildImageCardPrompt'), '未复用共享图片提示词');
  assert.ok(forge.includes('readImageDataUri'), '未复用共享图片读取');
  // 必须先判能力再发请求：没有识图能力时发纯文字会让用户以为模型读了图。
  // 断言限定在 imageToCard 函数体内（文件顶部的 import 行也含这些标识符）。
  const fnStart = forge.indexOf('const imageToCard = async');
  assert.ok(fnStart > 0, '找不到 imageToCard');
  const fnBody = forge.slice(fnStart, forge.indexOf('const pickReference', fnStart));
  assert.ok(fnBody.includes('supportsVision'), '缺识图能力判定');
  assert.ok(
    fnBody.indexOf('supportsVision') < fnBody.indexOf('readImageDataUri'),
    '能力判定必须发生在读图与请求之前'
  );
  assert.ok(fnBody.indexOf('readImageDataUri') < fnBody.indexOf('sendChatMessage'), '读图必须在请求之前');
  // 只合并文本字段：集合字段（世界书/正则/预设）不得被按图生成覆盖。
  assert.ok(forge.includes('mergeDraft'), '未复用草稿合并');
});

test('后台运行提示条：读应用级登记表，且只列非当前会话', () => {
  const bar = read(DESKTOP, 'src', 'chat', 'RunningNoticeBar.jsx');
  // 数据源必须是 sessionRuns（应用级事实），而不是宿主传进来的单个布尔——
  // 后者只能表达「当前会话在跑」，看不到切走后仍在后台跑的那一段。
  assert.ok(bar.includes("agent/runtime/sessionRuns.js"), '未读应用级登记表');
  assert.ok(bar.includes('sessionRuns.subscribe'), '未订阅运行变更');
  assert.ok(bar.includes('sessionRuns.cancel'), '缺停止后台运行');
  // 当前会话不重复显示（由输入区的停止键体现，与手机同口径）。
  assert.ok(bar.includes('!== String(activeSessionId'), '未过滤当前会话');
  // 宿主必须真的能切过去（不是空实现）。
  assert.ok(PANE.includes('chat.switchSession(sessionId)'), '「切过去」未接会话切换');
});

test('群聊成员增删：勾选即写回，且上限来自共享常量', () => {
  const dialog = read(DESKTOP, 'src', 'group', 'GroupSettingsPanel.jsx');
  assert.ok(dialog.includes('setGroupMembers'), '未接成员写入');
  assert.ok(dialog.includes('MAX_GROUP_MEMBERS'), '上限未复用共享常量');
  assert.ok(dialog.includes('MIN_GROUP_MEMBERS'), '下限未复用共享常量');
  assert.ok(dialog.includes('allCharacters'), '勾选列表未接全部角色');
  // 共享层的校验不能只靠界面：直接调存储也必须拒绝越界。
  const mutations = read(ROOT, 'src', 'storage', 'sessionList', 'mutations.js');
  assert.ok(mutations.includes('MIN_GROUP_MEMBERS') && mutations.includes('MAX_GROUP_MEMBERS'), '共享层未校验人数');
  assert.ok(mutations.includes('delete profiles[id]'), '移除成员时未清理 memberProfiles（会留下幽灵简介）');
});

test('运行中补充指令：走共享判定，且清草稿', () => {
  // 共享层的机会：resolveSteeringSend 区分 send/queued/blocked 三种结果，
  // 分别对应「正常发送」「注入下一轮」「不能注入（本轮不是工具循环 / 带附件）」。
  assert.ok(PANE.includes('resolveSteeringSend'), '未复用共享判定');
  assert.ok(PANE.includes('pushSteering'), '未接注入');
  assert.ok(PANE.includes("t('chat.send.steering.noLoop')"), '缺「本轮不能注入」的提示');
  // 注入后必须清掉落盘草稿，否则重启会把已注入的那句当未发草稿恢复。
  assert.ok(PANE.includes('persistDraftNow(activeSessionId'), '注入后未清草稿');
});

test('分叉点入口：可展开分支列表，且切换/删除接真实链路', () => {
  const row = read(DESKTOP, 'src', 'chat', 'BranchForkRow.jsx');
  // 两处都带参数（{ count }），所以只断言键名出现。
  assert.ok(row.includes('chat.branch.forkEntry'), '缺分叉点入口文案');
  assert.ok(row.includes('chat.branch.forkEntryRoot'), '缺「开头」分支的文案分支');
  assert.ok(row.includes("t('chat.branch.checkout')"), '缺切换');
  assert.ok(row.includes("t('chat.branch.delete')"), '缺删除');
  // 文本预览与条数来自共享层分组结果，不在这里重算。
  assert.ok(row.includes('branch.preview') && row.includes('branch.messageCount'), '未使用分支描述符字段');
  // 宿主必须真的接上 useDesktopBranches 的两个动作。
  assert.ok(PANE.includes('onDeleteBranch={target => branchesApi.remove(target)}'), '删除未接真实链路');
  assert.ok(PANE.includes('forkBranches={branchesApi.branchesByFork}'), '未接共享层分组结果');
});

test('气泡样式：设置真的生效（不是只存了一个值）', () => {
  // 回归：桌面曾把「气泡样式」放进设置页却不消费——改了没有任何效果。
  const row = read(DESKTOP, 'src', 'render', 'MessageRow.jsx');
  assert.ok(row.includes('resolveBubbleStyle'), '未消费共享决策层');
  for (const key of ['bubbleRadius', 'tailRadius', 'userBackground', 'bubblePaddingHorizontal', 'hasShadow']) {
    assert.ok(row.includes(key), `未使用 ${key}（样式会缺一块）`);
  }
  // 宿主要把 tokens 与 chatOptions.bubbleStyle 一路传到消息行。
  assert.ok(PANE.includes('bubbleStyle={chat.chatOptions && chat.chatOptions.bubbleStyle}'), '未传 bubbleStyle');
  assert.ok(PANE.includes('tokens={tokens}'), '未传 tokens（圆角/阴影取值来源）');
});

test('角色专属配置含 OCR 项（与手机 CharacterOverridesSection 对齐）', () => {
  const card = read(DESKTOP, 'src', 'character', 'CharacterOverrideCard.jsx');
  assert.ok(card.includes('ocrApiConfigId'), '缺 OCR 接口选择');
  assert.ok(card.includes('ocrModel'), '缺 OCR 模型选择');
  assert.ok(card.includes("t('character.overrides.ocr')"), '缺 OCR 区块标签');
  // 生效路径必须在共享层（useChatSend 用 resolveCharacterOcrSettings）。
  const send = read(ROOT, 'src', 'chat', 'useChatSend.js');
  assert.ok(send.includes('resolveCharacterOcrSettings'), '发送链路未读角色专属 OCR（选择会失效）');
});

test('动态：用户可以自己发布（不只是点赞/评论）', () => {
  const screen = read(DESKTOP, 'src', 'extension', 'screens', 'MomentsScreen.jsx');
  assert.ok(screen.includes("t('moments.post.placeholder')"), '缺发布输入框');
  assert.ok(screen.includes("authorType: 'user'"), '发布未标记为用户动态');
  assert.ok(screen.includes('runUserMomentComments'), '发布后未触发角色评论');
  // 必须走 startCommentTask：用户离开页面后评论不应被组件卸载中止。
  assert.ok(screen.includes('startCommentTask'), '评论未交给模块级 runner（离开页面会断）');
});

test('角色评论：音乐/书籍共用一套，且落库走共享 append', () => {
  assert.ok(COMMENTS.includes('buildTriggerCommentPrompt'), '音乐未复用提示词');
  assert.ok(COMMENTS.includes('buildPassageCommentPrompt'), '书籍未复用提示词');
  assert.ok(COMMENTS.includes('appendMusicComment'), '音乐评论未走共享写入');
  assert.ok(COMMENTS.includes('appendBookComment'), '书籍评论未走共享写入');
  // 读坏时如实提示，不能显示成「还没有评论」。
  assert.ok(COMMENTS.includes('corrupt'), '缺损坏态区分');
});