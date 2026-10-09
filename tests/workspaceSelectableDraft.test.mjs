// 工作区「文字可选择 + 输入草稿不丢」接线契约测试。
// 背景（2026-10-09 用户报告）：
//  ① 工作区聊天/文件正文长按无「复制/选择文字」——RN 的 Text 在 Android 默认不可选，
//     必须显式 selectable；工作区相关组件此前一次都没写过（主聊天页早就有了）。
//  ② 输入框草稿切面板即丢——WorkspaceScreen 条件渲染，切面板卸载 ChatPanel，
//     而 input 是组件内 useState，卸载即销毁；草稿改存会话（chat.draft + 内存缓存）。
// 逻辑本体在 storage/workspace.js（tests/workspaceChats.test.mjs 覆盖），这里守接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(path.join(HERE, '..', relative), 'utf8');

const chatSrc = read('src/workspace/screen/ChatPanel.js');
const filesSrc = read('src/workspace/screen/FilesPanel.js');
const storageSrc = read('src/storage/workspace.js');
const chatsSrc = read('src/workspace/chats.js');

test('selectable：消息气泡与文件正文可选中；列表行/状态行保持不可选（不吃长按）', () => {
  // 要能选的（内容型）
  assert.ok(chatSrc.includes('<Text style={styles.bubbleText} selectable>'),
    '消息气泡正文要能长按选择');
  assert.ok(filesSrc.includes('<Text style={styles.previewText} selectable>'),
    '文件预览正文要能长按选择');
  assert.ok(filesSrc.includes('styles.changeDetailText} selectable>{entry.find}'),
    '历史改动的「查找」原文要能复制');
  assert.ok(filesSrc.includes('styles.changeDetailText} selectable>{entry.replace}'),
    '历史改动的「替换」原文要能复制');

  // 不能加的（Android 上 selectable 会吃掉长按、干扰行点击）
  assert.ok(filesSrc.includes('<Text style={styles.fileName} numberOfLines={1}>'),
    '文件列表行的文件名保持不可选（加了会吃掉整行的长按/点击）');
  assert.ok(!filesSrc.includes('styles.fileName} selectable'), '文件名不可加 selectable');
  assert.ok(!chatSrc.includes('styles.statusText} numberOfLines={1} selectable'),
    '工具状态行是 UI 文本，不参与选择');
});

test('草稿落盘时机：卸载 / 关屏 / 切对话 / 新建 / 发送五处都要写回', () => {
  assert.ok(chatSrc.includes('saveWorkspaceChatDraft'), '存储函数已接线');
  assert.ok(chatSrc.includes('const draftCache = new Map()'),
    '内存缓存：切面板卸载后重新挂载要立刻有（不等异步落盘）');

  // 卸载兜底（切面板）与关屏：用 ref 取值落盘
  assert.ok(chatSrc.includes('persistDraft(characterIdRef.current, activeChatIdRef.current, inputRef.current)'),
    '卸载/关屏时要落盘最后一次输入');
  const refFlushCount = chatSrc.match(/persistDraft\(characterIdRef\.current/g)?.length || 0;
  assert.ok(refFlushCount >= 2, `卸载与关屏两条路径都要落盘（当前 ${refFlushCount} 处）`);

  // 切对话 / 新建对话：把当前输入存回原会话
  assert.ok(chatSrc.includes('persistDraft(characterId, activeChatId, input)'),
    '切换前先把输入存回原会话');
  // 发送后：清掉该会话草稿（否则下次切回来把发过的话又填回输入框）
  assert.ok(chatSrc.includes("persistDraft(ownerId, chatId, '')"), '发送成功后清草稿');

  // 打字只写内存，不落盘（落盘全在「离开」时点）
  assert.ok(chatSrc.includes('onChangeText={handleInputChange}'), '输入框接 onChangeText 包装');
  assert.ok(chatSrc.includes('rememberDraft(characterId, activeChatId, text)'),
    '打字时写内存草稿');
  assert.ok(!/onChangeText=\{setInput\}/.test(chatSrc), '不应再直连裸 setInput');
});

test('草稿载入：挂载与切对话都要读回（内存优先、盘上兜底）', () => {
  assert.ok(chatSrc.includes('setInput(readDraft(ownerId, active.id, active.draft))'),
    '载入会话时恢复草稿（内存优先，盘上 chat.draft 兜底）');
  assert.ok(chatSrc.includes('setInput(readDraft(characterId, id, target.draft))'),
    '切到历史会话时载入该会话的草稿');
  assert.ok(chatSrc.includes('draftCache.get(draftCacheKey(ownerId, id))'),
    '读顺序：内存缓存优先');
});

test('存储层与归一化：draft 字段就位且不参与排序', () => {
  assert.ok(chatsSrc.includes('export const WORKSPACE_CHAT_DRAFT_MAX'),
    '草稿有长度上限（防粘长文撑爆存储）');
  assert.ok(chatsSrc.includes('draft: truncate(source.draft, WORKSPACE_CHAT_DRAFT_MAX)'),
    '归一化带 draft 兜底（老数据无此字段）');
  assert.ok(storageSrc.includes('export function saveWorkspaceChatDraft'),
    '存储层提供按会话存草稿的入口');
  assert.ok(storageSrc.includes('normalizeWorkspaceChat({ ...target, draft: text, updatedAt: target.updatedAt })'),
    '草稿写入不改 updatedAt（打字不该把旧会话顶到历史最前）');
});
