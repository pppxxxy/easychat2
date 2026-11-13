// 密钥存储（design.md「适配层契约 3」）：对齐 expo-secure-store 的四个方法，
// 沿用 src/storage/secretStore.js 的 `secure:v1:<id>` 引用格式。
//
// - 写：safeStorage.encryptString(value) -> <root>/<sha256(id)>.bin（二进制）；
// - 读：解密失败或文件缺失返回 null（上层按「密钥不在」降级，与既有语义一致）；
// - isAvailableAsync：safeStorage.isEncryptionAvailable()；为假时 setItemAsync 走明文
//   实现并调用注入的 recordDiagnostic（Android 侧同样的降级路径）。
//
// 零 Electron 依赖：safeStorage 由主进程注入（测试注入假实现）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function idToFile(root, id) {
  const name = crypto.createHash('sha256').update(String(id), 'utf8').digest('hex');
  return path.join(root, `${name}.bin`);
}

export function createSecretStore({ root, safeStorage, recordDiagnostic = () => {} } = {}) {
  if (!root) throw new Error('createSecretStore: root is required');
  const dir = path.resolve(root);
  const ensureDir = () => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  };
  // safeStorage 不可用时用 base64 明文落盘：文件名仍带 .bin 后缀，行为与 Android
  // 降级分支一致（应用私有目录 + 诊断提示，不假装加密）。
  const available = () => !!(
    safeStorage
    && typeof safeStorage.isEncryptionAvailable === 'function'
    && safeStorage.isEncryptionAvailable()
  );

  return {
    dir,
    available,
    async getItemAsync(id) {
      const file = idToFile(dir, id);
      let data;
      try {
        data = fs.readFileSync(file);
      } catch (error) {
        return null;
      }
      try {
        if (available()) {
          const text = safeStorage.decryptString(data);
          return typeof text === 'string' ? text : null;
        }
        return Buffer.from(data.toString('utf8'), 'base64').toString('utf8');
      } catch (error) {
        // 解密失败（换机器/DPAPI 密钥变化）按「密钥不在」处理，不抛。
        recordDiagnostic('secret', error, `secret-decrypt: ${id}`);
        return null;
      }
    },
    async setItemAsync(id, value) {
      ensureDir();
      const file = idToFile(dir, id);
      let data;
      if (available()) {
        data = safeStorage.encryptString(String(value));
      } else {
        data = Buffer.from(Buffer.from(String(value), 'utf8').toString('base64'), 'utf8');
        recordDiagnostic('secret', new Error('safeStorage unavailable, falling back to plaintext'), `secret-set: ${id}`);
      }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
    },
    async deleteItemAsync(id) {
      try {
        fs.unlinkSync(idToFile(dir, id));
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    },
  };
}

export function registerSecretIpc(ipcMain, store) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(...args));
  handle('secret:available', () => store.available());
  handle('secret:get', id => store.getItemAsync(String(id)));
  handle('secret:set', (id, value) => store.setItemAsync(String(id), String(value)));
  handle('secret:remove', id => store.deleteItemAsync(String(id)));
}
