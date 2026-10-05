// 工作区改动历史：写入点装饰器 + 记录构造。
//
// 为什么包在 store 上：面板与聊天工具走的是同一个后端接口（createWorkspaceStore 的
// 返回值），装饰器是唯一能同时覆盖两条路径、又不重复实现记录逻辑的位置。
//
// 两条硬约束：
// 1) 记录失败一律吞掉——历史是辅助信息，绝不能因为它写不进去而让「文件到底写没写
//    成」变成薛定谔状态；
// 2) 只记录**成功**的写操作（写抛错就不该留下「已写入」的历史）。

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

let changeSeq = 0;

// 组装一条改动记录（纯函数；at/id 可注入便于测试）。字段与
// storage/workspace.js 的 normalizeWorkspaceChange 对齐（那边还会防御性截断）。
export function buildChangeEntry(input = {}, { now = Date.now(), idFactory } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const makeId = typeof idFactory === 'function'
    ? idFactory
    : () => `chg-${now}-${++changeSeq}`;
  return {
    id: makeId(),
    at: now,
    op: ['write', 'edit', 'delete'].includes(source.op) ? source.op : 'write',
    path: truncate(source.path, 200),
    created: source.created === true,
    length: Math.max(0, Math.floor(Number(source.length)) || 0),
    base64Length: Math.max(0, Math.floor(Number(source.base64Length)) || 0),
    count: Math.max(0, Math.floor(Number(source.count)) || 0),
    all: source.all === true,
    find: truncate(source.find, 160),
    replace: truncate(source.replace, 160),
  };
}

// 惰性 require：本模块保持零静态依赖（Node 测试直接注入 record 即可）。
function defaultRecord(characterId, entry) {
  try {
    const { appendWorkspaceChange } = require('../storage/workspace.js');
    return appendWorkspaceChange(characterId, entry);
  } catch (error) {
    return Promise.resolve(null);
  }
}

// 用记录装饰器包一层 store（同一组方法名）。record(characterId, entry) 可注入。
export function createHistoryRecordingStore(store, { record } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return store;
  const notify = typeof record === 'function' ? record : defaultRecord;
  const recordSafely = (characterId, entry) => {
    try {
      Promise.resolve(notify(characterId, entry)).catch(() => {});
    } catch (error) {}
  };
  // 写前探测文件是否已存在（区分「新建」与「覆盖」）；探测失败按新建处理，
  // 不影响写入本身。
  const probeExists = async (characterId, path) => {
    try {
      if (typeof store.fileUri !== 'function') return false;
      return !!(await store.fileUri({ characterId, path }));
    } catch (error) {
      return false;
    }
  };
  return {
    ...store,
    async writeWorkspaceFile(args = {}) {
      const existed = await probeExists(args.characterId, args.path);
      const result = await store.writeWorkspaceFile(args);
      recordSafely(args.characterId, buildChangeEntry({
        op: 'write',
        path: (result && result.path) || args.path,
        created: !existed,
        length: result && result.length,
      }));
      return result;
    },
    async writeWorkspaceBinaryFile(args = {}) {
      const existed = await probeExists(args.characterId, args.path);
      const result = await store.writeWorkspaceBinaryFile(args);
      recordSafely(args.characterId, buildChangeEntry({
        op: 'write',
        path: (result && result.path) || args.path,
        created: !existed,
        base64Length: result && result.base64Length,
      }));
      return result;
    },
    async editWorkspaceFile(args = {}) {
      const result = await store.editWorkspaceFile(args);
      recordSafely(args.characterId, buildChangeEntry({
        op: 'edit',
        path: (result && result.path) || args.path,
        find: args.find,
        replace: args.replace,
        count: result && result.count,
        all: args.all === true,
        length: result && result.length,
      }));
      return result;
    },
    async deleteFile(args = {}) {
      const result = await store.deleteFile(args);
      if (result && result.deleted) {
        recordSafely(args.characterId, buildChangeEntry({
          op: 'delete',
          path: (result && result.path) || args.path,
        }));
      }
      return result;
    },
  };
}