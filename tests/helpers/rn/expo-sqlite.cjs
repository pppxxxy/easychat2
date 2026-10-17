'use strict';
// `expo-sqlite` 的 Node 端桩。
//
// 仓库只在 src/storage/io.js 用它做**一件事**：AsyncStorage 单值超过 CursorWindow
// 上限时的分块兜底（`openDatabase('../../databases/RKStorage')` 后按偏移读 value 切片）。
// 因此桩只实现那两条 SQL 形状，其余显式抛「未打桩」——宁可炸也不返回假数据，
// 否则「大值读不回」这条故障路径会绿得毫无意义。

let rows = new Map(); // key -> 完整字符串
let dbOpenCount = 0;
const calls = { exec: 0, open: 0 };

function queryText(query) {
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object') return String(query.sql || '');
  return '';
}

function queryArgs(query) {
  if (query && typeof query === 'object' && Array.isArray(query.args)) return query.args;
  return [];
}

const database = {
  async execAsync(queries) {
    calls.exec += 1;
    const list = Array.isArray(queries) ? queries : [queries];
    const results = [];
    for (const query of list) {
      const sql = queryText(query);
      const args = queryArgs(query);
      if (/length\s*\(\s*value\s*\)/i.test(sql)) {
        const key = args[args.length - 1];
        const value = rows.has(key) ? rows.get(key) : '';
        results.push({ rows: [{ total: value.length }] });
        continue;
      }
      if (/substr\s*\(|substring\s*\(/i.test(sql)) {
        const offset = Number(args[0]) - 1;
        const size = Number(args[1]);
        const key = args[args.length - 1];
        const value = rows.has(key) ? rows.get(key) : '';
        results.push({ rows: [{ chunk: value.slice(offset, offset + size) }] });
        continue;
      }
      throw new Error(`expo-sqlite 桩：未打桩的 SQL「${sql.slice(0, 80)}」（仓库当前只用分块读兜底）`);
    }
    return results;
  },
  async closeAsync() {},
  async getAllAsync(sql, args) {
    return this.execAsync([{ sql, args }]);
  },
};

const SQLite = {
  openDatabase(name) {
    calls.open += 1;
    dbOpenCount += 1;
    database.name = name;
    return database;
  },
  async openDatabaseAsync(name) {
    return SQLite.openDatabase(name);
  },
  async deleteDatabaseAsync() {},
};

module.exports = SQLite;
module.exports.default = SQLite;
module.exports.__esModule = true;

// ---- 测试自省与编程接口 ----
module.exports.__reset = () => {
  rows = new Map();
  dbOpenCount = 0;
  for (const key of Object.keys(calls)) calls[key] = 0;
};
module.exports.__seed = entries => {
  for (const [key, value] of Object.entries(entries)) rows.set(key, String(value));
};
module.exports.__calls = calls;
module.exports.__openCount = () => dbOpenCount;
