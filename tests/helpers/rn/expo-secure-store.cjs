'use strict';
// `expo-secure-store` 的 Node 端桩（内存 Keystore）。
//
// 仓库只在 src/storage/secretStore.js 一个文件里用它，接口面是：
//   setItemAsync / getItemAsync / deleteItemAsync，外加 isAvailableAsync。
// 桩必须能表达**失败**（Keystore 不可用 / 读不回），因为 secretStore 的两条
// 「读不回」纪律全靠这些失败分支：读不回不许回写成空串、引用不许越出内存边界。

let values = new Map();
let available = true;
let failWrites = false;
let failReads = false;
const calls = { set: 0, get: 0, delete: 0 };

const SecureStore = {
  // 真实实现的单值上限是 2048 字节；桩保留这个限制，否则「按对象逐值保护」
  // 这条设计理由（见 secretStore.js 头注）在测试里就看不见了。
  async setItemAsync(key, value) {
    calls.set += 1;
    if (!available) throw new Error('secure-store unavailable');
    if (failWrites) throw new Error(`secure-store setItemAsync failed: ${key}`);
    const text = String(value);
    if (Buffer.byteLength(text, 'utf8') > 2048) {
      throw new Error(`secure-store value exceeds 2048 bytes: ${key}`);
    }
    values.set(String(key), text);
  },

  async getItemAsync(key) {
    calls.get += 1;
    if (!available) throw new Error('secure-store unavailable');
    if (failReads) throw new Error(`secure-store getItemAsync failed: ${key}`);
    return values.has(String(key)) ? values.get(String(key)) : null;
  },

  async deleteItemAsync(key) {
    calls.delete += 1;
    if (!available) throw new Error('secure-store unavailable');
    values.delete(String(key));
  },

  async isAvailableAsync() {
    return available;
  },
};

module.exports = SecureStore;
module.exports.default = SecureStore;
module.exports.__esModule = true;

// ---- 测试自省与编程接口 ----
module.exports.__reset = () => {
  values = new Map();
  available = true;
  failWrites = false;
  failReads = false;
  for (const key of Object.keys(calls)) calls[key] = 0;
};
module.exports.__dump = () => new Map(values);
module.exports.__calls = calls;
module.exports.__setAvailable = value => {
  available = value === true;
};
module.exports.__failWrites = value => {
  failWrites = value === true;
};
module.exports.__failReads = value => {
  failReads = value === true;
};
