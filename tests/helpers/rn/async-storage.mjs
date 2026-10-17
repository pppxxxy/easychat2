// AsyncStorage 的 Node 端桩：内存 Map 实现，语义对齐真实库。
//
// 与 tests/characterStorage.test.mjs 里那份手写假实现的区别：那份是**用例内**可编程的
// （能定向让某个 key 读写失败），这份是**共享底座**，供多个渲染测试复用，
// 因此保持默认全成功、并暴露 __reset/__seed/__fail 给用例按需注入。
//
// 默认导出是对象本身（真实库的 default 就是它），具名导出仅供用例做自省。

let store = new Map();
let failGetKeys = new Set();
let failSetKeys = new Set();
const calls = {
  get: 0, set: 0, remove: 0, merge: 0, multiGet: 0, multiSet: 0, multiRemove: 0, getAllKeys: 0, clear: 0,
};

const AsyncStorage = {
  async getItem(key) {
    calls.get += 1;
    if (failGetKeys.has(key)) throw new Error(`async-storage getItem failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    calls.set += 1;
    if (failSetKeys.has(key)) throw new Error(`async-storage setItem failed: ${key}`);
    store.set(String(key), String(value));
  },
  async removeItem(key) {
    calls.remove += 1;
    store.delete(String(key));
  },
  async mergeItem(key, value) {
    calls.merge += 1;
    const previous = store.has(key) ? JSON.parse(store.get(key)) : {};
    store.set(String(key), JSON.stringify({ ...previous, ...JSON.parse(value) }));
  },
  async multiGet(keys) {
    calls.multiGet += 1;
    return keys.map(key => [key, store.has(key) ? store.get(key) : null]);
  },
  async multiSet(pairs) {
    calls.multiSet += 1;
    for (const [key, value] of pairs) {
      if (failSetKeys.has(key)) throw new Error(`async-storage multiSet failed: ${key}`);
      store.set(String(key), String(value));
    }
  },
  async multiRemove(keys) {
    calls.multiRemove += 1;
    for (const key of keys) store.delete(String(key));
  },
  async getAllKeys() {
    calls.getAllKeys += 1;
    return [...store.keys()];
  },
  async clear() {
    calls.clear += 1;
    store.clear();
  },
  async flushGetRequests() {},
  useAsyncStorage(key) {
    return {
      getItem: () => AsyncStorage.getItem(key),
      setItem: value => AsyncStorage.setItem(key, value),
      removeItem: () => AsyncStorage.removeItem(key),
      mergeItem: value => AsyncStorage.mergeItem(key, value),
    };
  },
};

export default AsyncStorage;

// ---- 测试自省与编程接口（__ 前缀标明非库 API）----
export function __reset() {
  store = new Map();
  failGetKeys = new Set();
  failSetKeys = new Set();
  for (const key of Object.keys(calls)) calls[key] = 0;
}

export function __seed(entries) {
  for (const [key, value] of Object.entries(entries)) store.set(key, String(value));
}

export function __dump() {
  return new Map(store);
}

export function __calls() {
  return calls;
}

export function __failGet(keys) {
  for (const key of keys) failGetKeys.add(key);
}

export function __failSet(keys) {
  for (const key of keys) failSetKeys.add(key);
}

export function __clearFailures() {
  failGetKeys = new Set();
  failSetKeys = new Set();
}
