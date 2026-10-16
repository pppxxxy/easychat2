// FEAT-AC12 P0-1：工作区目录遍历的**结果缓存**（纯逻辑，Node 直测）。
//
// 为什么需要它（真机 20:49–21:01 的卡顿主因）：
// store.js / safStore.js 的 walk() 是**逐条目串行**的（每个文件一次 getInfo、
// 每个目录一次 readDirectoryAsync，全部 await），上限 MAX_FILES=2000。用户工作区里
// 克隆了一个数千文件的 RN 仓库之后，**每次进入文件/GitHub 面板都重跑一遍全树遍历**
// ——在 Android SAF 上是数千次串行跨进程 IPC。「点了没反应 → 唰一下全出来」
// 的观感就是它。
//
// 而遍历结果在两次写操作之间**根本不会变**。所以缓存是这里最直接的正确解：
//   ① 重复进入面板 = 0 次 IO（首屏即时）；
//   ② 自家写操作后按 characterId 打脏 → 下一次读取重算（不会给出过期清单）。
//
// ⚠️ 为什么必须有**写后失效**（不能只有缓存）：本仓反复坚持的口径是
//「读不到 ≠ 没有」，反过来同样成立——**缓存给出过期清单，等于让用户以为
// 刚建的文件不存在**（那比慢严重得多，是同一种「静默说谎」）。所以：
//   · 所有经过 store 的写（write/edit/mkdir/move/delete）一律失效；
//   · run_shell 与 materialize_repo 这类**绕过 store 的写**必须显式调用
//     invalidateWorkspaceListCache（见 shell.js / materializeTool.js 的接线）。
//
// 边界（如实标注）：用户在**应用外部**（系统文件管理器 / SAF 另一端）改动的文件，
// 本缓存不会自动感知——那类改动要等一次自家写操作或面板重挂载才会反映出来。
// 这是缓存换来的代价，写在此处以免后人以为它是实时的。

// 键：同一角色在不同根（应用私有 / 用户选的 SAF 文件夹）下的清单必须分开——
// 换了根却命中旧缓存会让用户看到**另一个文件夹**的内容（比慢更糟）。
// depth 必须进键（FEAT-AC12 P0-1 补充）：单层（depth:1，文件面板下钻用）与
// 全量（不传，聊天工具 list_workspace_files 用）是**不同的清单语义**——若共用键，
// 面板先请求的单层结果会被工具侧当完整清单命中，模型把不完整清单当完整事实
// 推理（G1.7 要防的事故形态）。undefined 与 '' 都归一为空段（全量语义）。
export function listCacheKey({ root = '', characterId = '', subdir = '', match = '', depth } = {}) {
  return [
    String(root || ''),
    String(characterId || ''),
    String(subdir || ''),
    String(match || ''),
    depth === undefined || depth === null ? '' : String(depth),
  ].join('\u0000');
}

/**
 * 目录清单缓存。模块级单例由调用方持有（见 native.js 的 workspaceListCache）——
 * **不能放在 store 实例里**：createWorkspaceStore 每次调用都新建实例
 *（面板每次 visible 变化都会重建），实例级缓存等于没有缓存。
 */
export function createWorkspaceListCache() {
  // key → { files, truncated }
  const entries = new Map();
  // key → Promise（同一 key 的并发读取合并成一次真实遍历）。
  const inflight = new Map();

  function get(key) {
    return entries.get(key) || null;
  }

  function set(key, value) {
    if (!key) return value;
    entries.set(key, value);
    return value;
  }

  /**
   * 读穿缓存：命中直接回（0 次 IO）；未命中则跑 loader 并记住。
   *
   * 并发合并：同一 key 上两个同时到达的读取只跑一次 loader，两者拿到**同一个**
   * 结果对象——这与「面板挂载 + 用户点刷新」同时发生时的实际形态一致。
   */
  function withCache(key, loader) {
    const hit = entries.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
    const task = Promise.resolve()
      .then(() => loader())
      .then(value => {
        // 只记成功结果：loader 抛错时不留半个缓存（下次仍会真的重试）。
        set(key, value);
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, task);
    return task;
  }

  /**
   * 失效。
   *
   * 不传 characterId = 全部失效（换根/换设置时用——那时键里的 root 变了，
   * 但旧键的条目留着只是浪费内存，清掉更干净）。
   * 传了 characterId = 只清该角色的键（其余角色/线程的清单仍可命中）。
   */
  function invalidate(characterId = '') {
    const target = String(characterId || '');
    if (!target) {
      entries.clear();
      return;
    }
    // 键的构成是 root\0characterId\0subdir\0match —— 用分隔符精确匹配第二段，
    // 不能写 includes（角色 id 可能是另一个的前缀：'a' 会误伤 'ab'）。
    const needle = `\u0000${target}\u0000`;
    for (const key of [...entries.keys()]) {
      if (key.includes(needle)) entries.delete(key);
    }
  }

  function size() {
    return entries.size;
  }

  function __reset() {
    entries.clear();
    inflight.clear();
  }

  return { get, set, withCache, invalidate, size, __reset };
}

// 应用级单例：面板与工具读到的是同一份清单。
export const workspaceListCache = createWorkspaceListCache();

/** 宿主入口：写操作之后打脏（不传 = 全部失效）。 */
export function invalidateWorkspaceListCache(characterId = '') {
  workspaceListCache.invalidate(characterId);
}

// 需要「写后打脏」的方法：任何一个都会改变目录清单。
// 与 history.js 的装饰器**同一形状**（同一组方法名、同样的批处理语义）——
// 两个装饰器的存在理由相同：不侵入后端实现，把横切关注点包在 store 外面。
const WRITE_METHODS = Object.freeze([
  'writeWorkspaceFile',
  'writeWorkspaceBinaryFile',
  'editWorkspaceFile',
  'createWorkspaceDirectory',
  'moveWorkspaceDirectory',
  'deleteFile',
  'deleteWorkspaceDirectory',
]);

/**
 * 用**清单缓存**装饰一个 store（同一组方法名）。
 *
 * 为什么是装饰器而不是改 walk()：walk 在 store.js 与 safStore.js 各有一份，
 * 而缓存是**与后端无关**的横切关注点（两个后端的清单语义一致）。包在外面
 * 一次装好，两个后端同时受益，也不必在两处各写一份失效逻辑（那必然漂移）。
 * 这与 createHistoryRecordingStore 的选择完全相同。
 *
 * 批处理语义（对齐 history.js）：beginBatch 之后逐文件写不再各自打脏
 *（导入 600 文件 = 600 次无谓失效），只在 endBatch 打一次；abortBatch 也要打
 * ——批次中途取消时前面已经写进去的文件同样改变了清单。
 *
 * @param {object} store 后端 store
 * @param {object} [options]
 * @param {string} [options.rootKey] 根标识（不同根/不同工作区必须分开缓存——
 *   换了根却命中旧缓存会让用户看到**另一个文件夹**的内容）。调用方给（native.js
 *   从 location 算），因为两个后端都没暴露自己的根。
 * @param {object} [options.cache] 可注入（测试用）
 */
export function createListCachingStore(store, { rootKey = '', cache = workspaceListCache } = {}) {
  if (!store || typeof store.listWorkspaceFilesWithMeta !== 'function') return store;
  // 批内挂起失效标记：批结束（或取消）时统一打一次。
  let batchDirty = false;

  const wrapWrite = name => {
    const original = store[name];
    if (typeof original !== 'function') return undefined;
    return async function cachedWrite(args = {}) {
      const result = await original.call(store, args);
      // 写成功才失效：抛错时存储没变（或状态未知但不该假装干净）。
      // 批内只记标记（600 文件导入 = 1 次失效，不是 600 次）。
      if (batchDirty) return result;
      if (args && args.characterId !== undefined && args.characterId !== null) {
        cache.invalidate(args.characterId);
      } else {
        // 拿不到角色 id：无法精确失效，宁可全清（少命中一次，不可给过期清单）。
        cache.invalidate();
      }
      return result;
    };
  };

  const wrapped = { ...store };
  for (const name of WRITE_METHODS) {
    const fn = wrapWrite(name);
    if (fn) wrapped[name] = fn;
  }

  // 批处理：进批时置真，出批打脏。
  // ⚠️ 这里**不转发**给内层 beginBatch：history 装饰器在内层时它有自己的批状态，
  // 两层的批标记各管各的。但我们必须在**最外层**也提供同名方法（否则 history 的
  // beginBatch 会被本层的 {...store} 透传出去而漏掉打脏）。
  const innerBeginBatch = typeof store.beginBatch === 'function' ? store.beginBatch.bind(store) : null;
  const innerEndBatch = typeof store.endBatch === 'function' ? store.endBatch.bind(store) : null;
  const innerAbortBatch = typeof store.abortBatch === 'function' ? store.abortBatch.bind(store) : null;

  return {
    ...wrapped,
    beginBatch(characterId, meta = {}) {
      batchDirty = true;
      if (innerBeginBatch) innerBeginBatch(characterId, meta);
    },
    endBatch() {
      batchDirty = false;
      // 批可能跨角色（导入/物化），全清最稳；批次是低频操作，不值得为精确失效冒险。
      cache.invalidate();
      return innerEndBatch ? innerEndBatch() : null;
    },
    abortBatch() {
      // 取消也要打脏：批次中途已经写进去的文件同样改变了清单。
      batchDirty = false;
      cache.invalidate();
      if (innerAbortBatch) innerAbortBatch();
    },

    // 读穿缓存：命中即 0 次 IO。两个列表入口共用同一份缓存条目
    //（listWorkspaceFiles 是 WithMeta 的降级包装，缓存键完全相同）。
    // depth 随 args 进键（见 listCacheKey 注释）：单层与全量互不污染。
    listWorkspaceFilesWithMeta(args = {}) {
      const key = listCacheKey({
        root: rootKey,
        characterId: args.characterId,
        subdir: args.subdir,
        match: args.match,
        depth: args.depth,
      });
      return cache.withCache(key, () => store.listWorkspaceFilesWithMeta(args));
    },
    async listWorkspaceFiles(args = {}) {
      const detailed = await this.listWorkspaceFilesWithMeta(args);
      return detailed.files;
    },
  };
}

