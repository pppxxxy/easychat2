// esbuild 打包入口（桌面单角色锁集成测试用）：共享层 security 存储 + 桌面 secureStore 适配。
export {
  isCharacterLocked,
  setCharacterLock,
  removeCharacterLock,
  verifyCharacterPasscode,
  getCharacterLocks,
  getSecuritySettings,
  setCharacterLockHint,
  getCharacterLockHint,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
} from '../../../src/storage/security.js';
