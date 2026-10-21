// 角色库写入的**乐观并发**编排：记住「我读到的是哪一版」，写的时候带上它，
// 撞上别人先写就刷新后重试。
//
// 为什么需要：storage 的 persistLibrary 把「不在 list 里的 id」当 stale 删掉，于是
// 任何基于旧快照的整体写都会顺手删掉别人刚加的卡，而且**不报错**（实测：MCP 建完卡，
// App 拿旧列表一保存，新卡就被当 stale 清了）。存储层现在比对版本号并抛冲突
// （storage/characters/index.js 的 expectedRevision），这个模块负责两件事：
// 「把版本号传下去」和「冲突之后怎么办」。
//
// 为什么不写进 AppContext：它已贴着 800 行棘轮上限（799/800），而这段要几十行。
// 摊成独立模块还能单测——AppContext 是 RN 组件，Node 里跑不起来。
//
// 版本号必须来自「这次 list 的来处」那一版，不能读盘上最新版：用最新版校验等于没校验
// （旧快照会被当成最新的写进去）。所以每读一次库就 prime 一次。

import {
  getCharacterLibrary,
  getCharacterLibraryRevision,
  isCharacterLibraryConflict,
  saveCharacterLibrary,
} from '../storage/characters.js';
import { saveCharacterState } from '../storage/characterState.js';

// 最多试几次。3 次足够吃掉「MCP 刚写完 + 界面正在刷新」这类短窗口；再多就是在掩盖
// 真正的反复争用——那种情况应该把错误交出去，而不是无限重试。
const MAX_ATTEMPTS = 3;

// 模块级单例：整个进程只有一份角色库，也就只需要一份「我读到哪一版」。
// null = 不知道（索引损坏 / 还没读过），此时不做版本校验（见 storage 侧注释）。
let libraryRevision = null;

export function currentLibraryRevision() {
  return libraryRevision;
}

// 重置跟踪：测试用；也用于「库被整体替换」（导入备份）后强制重新对齐。
export function resetLibraryRevision() {
  libraryRevision = null;
}

// 从盘上重读版本号。任何「读库」之后都该调它，让后续写入基于正确的版本。
export async function primeLibraryRevision() {
  try {
    libraryRevision = await getCharacterLibraryRevision();
  } catch (error) {
    libraryRevision = null;
  }
  return libraryRevision;
}

// 读库 + 同步版本号。两者必须来自同一次读，否则「拿 A 的数据、配 B 的版本号」去写
// 正是这里要防的事。
export async function loadCharacterLibraryWithRevision() {
  const list = await getCharacterLibrary();
  await primeLibraryRevision();
  return list;
}

// 追写一次；成功则把本地版本号推进一版（存储层写的就是 当前+1）。
// null 表示不知道版本 → 传 undefined，存储层据此跳过校验。
async function runSave(save) {
  const options = libraryRevision === null ? undefined : { expectedRevision: libraryRevision };
  const saved = await save(options);
  if (libraryRevision !== null) libraryRevision += 1;
  return saved;
}

// 保存整库（带版本校验）。
export async function saveCharacterLibraryTracked(list) {
  return runSave(options => saveCharacterLibrary(list, options));
}

// 保存库 + 活动角色（删卡/切卡用；内部调一次 saveCharacterLibrary，只推进一版）。
// extra.deletedIds / extra.clearVectorIds 对应 saveCharacterState 的第 3、4 个参数。
export async function saveCharacterStateTracked(list, activeId, extra = {}) {
  const deletedIds = extra.deletedIds;
  const clearVectorIds = extra.clearVectorIds === undefined ? [] : extra.clearVectorIds;
  return runSave(options => saveCharacterState(list, activeId, deletedIds, clearVectorIds, options));
}

// 冲突就刷新、重试。
//
// `run` **必须**在每次调用时重新从最新状态推导要写的内容——AppContext 的每个变更闭包
// 本来就是这么写的（进函数先 snapshotState()）。如果 `run` 闭包住一份旧 list，重试只会
// 拿同一份旧数据再撞一次，这个包装就退化成「重试三次都失败」。
export async function runWithLibraryConflictRetry(run, refresh) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isCharacterLibraryConflict(error)) throw error;
      lastError = error;
      try {
        await refresh();
      } catch (refreshError) {
        // 刷新都失败了就别再重试：把**原始冲突**抛回去。换成刷新错误会掩盖真正的成因。
        throw error;
      }
    }
  }
  throw lastError;
}

// 仅测试用：把模块级的版本跟踪清干净，避免用例之间串。
export { MAX_ATTEMPTS as __maxConflictAttemptsForTests };
