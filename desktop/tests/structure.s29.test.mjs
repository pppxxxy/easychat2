// 桌面外壳结构守卫（S29）：最后三处的逐控件比对（记忆行/角色库批量/群聊创建）。
//
// 查出的缺口（前两处是数据完整性，不只是少个按钮）：
//   1. **角色删除不清理关联数据**。桌面只调 deleteCharacter(id)——角色表那一行没了，
//      但它的会话、动态、向量记忆全留在盘上，成为孤儿数据（记忆页能扫出
//      「消息还在、会话没了」那类）。手机通过 runCharacterDelete 顺序编排三步。
//   2. **角色库没有批量删除**。手机有选择模式 + deleteCharacters(ids)。
//   3. **记忆页缺「屏幕对话」管理**。共享 useScreenWatchThreads 早已完整
//      （加载/三态/删除/清空空线程/清空全部），桌面完全没接。
//   群聊创建流程：基本对齐（桌面 222 行 vs 手机 187，反而更全）。
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

const DELETE_HOOK = read('src', 'character', 'useDesktopCharacterDelete.js');
const LIBRARY = read('src', 'character', 'CharacterLibraryScreen.jsx');
const SHELL = read('src', 'provider', 'DesktopApp.jsx');
const SCREEN_THREADS = read('src', 'memory', 'ScreenWatchThreadsPanel.jsx');
const MEMORY = read('src', 'memory', 'MemoryListScreen.jsx');
const GROUP_CREATE = read('src', 'group', 'GroupCreatePanel.jsx');

test('角色删除：走共享 runCharacterDelete 编排（角色 + 动态 + 会话）', () => {
  assert.ok(DELETE_HOOK.includes('runCharacterDelete'), '未复用共享删除编排');
  // 顺序与失败语义：先删角色（失败则后续不动），再按用户选择删动态/会话。
  assert.ok(/deleteCharactersStep/.test(DELETE_HOOK), '缺角色删除步骤');
  assert.ok(/removeMomentsStep/.test(DELETE_HOOK), '缺动态删除步骤');
  assert.ok(/deleteSessionsStep/.test(DELETE_HOOK), '缺会话删除步骤');
  // 关联数据统计：用户要在确认框里看见「会连带删掉 N 段对话 / N 条动态」。
  assert.ok(DELETE_HOOK.includes('countMomentsForCharacterDeletion'), '缺动态计数');
  assert.ok(DELETE_HOOK.includes('selectSessionsForCharacters'), '缺会话筛选');
  assert.ok(DELETE_HOOK.includes('normalizeDeleteTargetIds'), '应复用共享目标归一（排除默认角色）');
  // 动态读不出来必须抛（宁可不删，也不在不知道关联量时动手）。
  assert.ok(/moments-corrupt/.test(DELETE_HOOK), '动态读坏应中止');
  // 宿主确实用了这个 hook，而不是继续裸调 deleteCharacter。
  assert.ok(SHELL.includes('useDesktopCharacterDelete'), '宿主未接入删除编排');
  assert.ok(!/onDelete=\{id => run\('delete', \(\) => deleteCharacter\(id\)\)\}/.test(SHELL),
    '不应再裸调 deleteCharacter（会留孤儿数据）');
});

test('角色库：删除给「只删角色 / 连记忆一起删」两选', () => {
  assert.ok(LIBRARY.includes('onCollectDeleteImpact'), '缺关联数据统计入口');
  assert.ok(LIBRARY.includes('character.library.delete.withLinked'), '缺关联数据确认文案');
  assert.ok(LIBRARY.includes('character.library.delete.onlyCharacter'), '缺「只删角色」选项');
  assert.ok(LIBRARY.includes('character.library.delete.detail.memories'), '缺会话计数文案');
  assert.ok(LIBRARY.includes('character.library.delete.detail.moments'), '缺动态计数文案');
  // 插值参数必须与词条一致（intro/details），不是自造 name。
  assert.ok(/intro:/.test(LIBRARY) && /details:/.test(LIBRARY), '插值参数名应与词条一致');
  const zh = readRoot('src', 'i18n', 'locales', 'zh-CN', 'character.js');
  assert.ok(zh.includes("'{intro}\\n关联数据：{details}"), '词条应使用 intro/details');
});

test('记忆页：屏幕对话管理接上共享 hook（三态 + 删除 + 清空）', () => {
  assert.ok(SCREEN_THREADS.includes('useScreenWatchThreads'), '未复用共享 hook');
  assert.ok(MEMORY.includes('ScreenWatchThreadsPanel'), '记忆页未挂屏幕对话面板');
  // 三态：读失败必须如实说，不能渲染成「没有」。
  assert.ok(SCREEN_THREADS.includes('threadsFailed'), '缺读失败态');
  assert.ok(SCREEN_THREADS.includes('memory.screenWatch.readFailed.title'), '缺读失败文案');
  // 删除 / 清空空线程 / 清空全部都来自 hook（含失败必弹提示的纪律）。
  assert.ok(/handleDeleteThread/.test(SCREEN_THREADS), '缺删除');
  assert.ok(/handleClearEmptyThreads/.test(SCREEN_THREADS), '缺清空空线程');
  assert.ok(/handleClearAllThreads/.test(SCREEN_THREADS), '缺清空全部');
  // 预览与分组用共享纯函数。
  assert.ok(SCREEN_THREADS.includes('screenThreadPreview'), '缺预览');
});

test('群聊创建：控件与手机对齐（桌面反而更全）', () => {
  for (const key of [
    'character.library.group.createTitle',
    'character.library.group.nameLabel',
    'character.library.group.selectMembers',
    'character.library.group.avatarLabel',
    'character.library.group.bgLabel',
  ]) {
    assert.ok(GROUP_CREATE.includes(key), `群聊创建缺 ${key}`);
  }
  // 成员上限走共享常量（与创建面板同一份，不写死 8）。
  assert.ok(/MAX_GROUP_MEMBERS|MIN_GROUP_MEMBERS/.test(GROUP_CREATE), '成员边界应走共享常量');
});