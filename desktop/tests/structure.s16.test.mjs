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

test('角色评论：音乐/书籍共用一套，且落库走共享 append', () => {
  assert.ok(COMMENTS.includes('buildTriggerCommentPrompt'), '音乐未复用提示词');
  assert.ok(COMMENTS.includes('buildPassageCommentPrompt'), '书籍未复用提示词');
  assert.ok(COMMENTS.includes('appendMusicComment'), '音乐评论未走共享写入');
  assert.ok(COMMENTS.includes('appendBookComment'), '书籍评论未走共享写入');
  // 读坏时如实提示，不能显示成「还没有评论」。
  assert.ok(COMMENTS.includes('corrupt'), '缺损坏态区分');
});