// 键值仓（design.md「适配层契约 1」）：一键一文件 + 临时文件 + 原子重命名。
//
// 为什么不是单个 JSON 文件：Android 侧单值有 ~2MB CursorWindow 限制、满仓读改写有
// 丢失窗口；一键一文件把两个问题一起消除，且单值 100MB 与 2MB 走同一条路径。
//
// 文件布局：<root>/<sha256(key)>.json，内容 { key, value }。
// - 文件名用哈希：键里可能含 ':' '/' 等不适合做文件名的字符（如 messages::<sessionId>）；
// - 内容里保留原始 key：getAllKeys 必须回填键名（从文件名反推不可能）。
//
// 错误语义对齐 storage/io.js：文件不存在 -> null；JSON 损坏 -> 抛错（上层判 corrupt
// 并走 __corrupt_backup 备份流程）；写入中断 -> 旧值仍可读（tmp + rename 保证）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

export function createKvStore({ root, fsImpl = fs } = {}) {
  if (!root) throw new Error('createKvStore: root is required');
  const dir = path.resolve(root);

  const fileOf = key => path.join(dir, `${hashKey(key)}.json`);

  function ensureDir() {
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  }

  // 启动时清理残留 .tmp：进程被强杀时可能留下半截临时文件（design.md「Error Handling」）。
  function cleanupTmp() {
    if (!fsImpl.existsSync(dir)) return 0;
    let removed = 0;
    for (const name of fsImpl.readdirSync(dir)) {
      if (!name.endsWith('.tmp')) continue;
      try {
        fsImpl.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch (error) {}
    }
    return removed;
  }

  function readEntry(key) {
    const file = fileOf(key);
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
    // JSON 损坏直接抛：上层（src/storage/io.js readJsonStatus）据此判 corrupt 并备份原文件。
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.value !== 'string') {
      throw new Error(`kv entry shape invalid: ${key}`);
    }
    return parsed;
  }

  function writeAtomic(key, value) {
    ensureDir();
    const file = fileOf(key);
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify({ key: String(key), value: String(value) });
    let fd;
    try {
      fd = fsImpl.openSync(tmp, 'w');
      fsImpl.writeFileSync(fd, payload, 'utf8');
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = undefined;
      // rename 在同一目录内是原子的：读者要么看到旧文件、要么看到新文件。
      fsImpl.renameSync(tmp, file);
    } catch (error) {
      if (fd !== undefined) {
        try { fsImpl.closeSync(fd); } catch (closeError) {}
      }
      try { fsImpl.unlinkSync(tmp); } catch (unlinkError) {}
      throw error;
    }
  }

  return {
    dir,
    cleanupTmp,
    get(key) {
      const entry = readEntry(key);
      return entry ? entry.value : null;
    },
    set(key, value) {
      writeAtomic(key, value);
    },
    remove(key) {
      try {
        fsImpl.unlinkSync(fileOf(key));
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    },
    keys() {
      if (!fsImpl.existsSync(dir)) return [];
      const keys = [];
      for (const name of fsImpl.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const entry = readEntryByFile(path.join(dir, name));
          if (entry && typeof entry.key === 'string') keys.push(entry.key);
        } catch (error) {
          // 单个键损坏不拖垮 getAllKeys：跳过（损坏键会在 get 时被上层判 corrupt）。
        }
      }
      return keys;
    },
    multiGet(keys) {
      return keys.map(key => {
        try {
          const entry = readEntry(key);
          return [key, entry ? entry.value : null];
        } catch (error) {
          return [key, null];
        }
      });
    },
    multiSet(entries) {
      for (const [key, value] of entries) writeAtomic(key, value);
    },
    multiRemove(keys) {
      for (const key of keys) this.remove(key);
    },
  };

  function readEntryByFile(file) {
    const text = fsImpl.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  }
}

// ipcMain 注册（主进程调用；测试不经过这里，直接测上面的 store）。
export function registerKvIpc(ipcMain, store) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(...args));
  handle('kv:get', key => store.get(String(key)));
  handle('kv:set', (key, value) => store.set(String(key), String(value)));
  handle('kv:remove', key => store.remove(String(key)));
  handle('kv:keys', () => store.keys());
  handle('kv:multiGet', keys => store.multiGet((keys || []).map(String)));
  handle('kv:multiSet', entries => store.multiSet((entries || []).map(([k, v]) => [String(k), String(v)])));
  handle('kv:multiRemove', keys => store.multiRemove((keys || []).map(String)));
  store.cleanupTmp();
}
