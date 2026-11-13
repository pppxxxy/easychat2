// esbuild 打包入口（桌面全局预设集成测试用）：共享层预设存储 + 桌面 AsyncStorage 适配。
export {
  createGlobalPresetId,
  getGlobalPresetSettings,
  getGlobalPresets,
  getEnabledGlobalPresetPrompts,
  saveGlobalPresetSettings,
  saveGlobalPresets,
} from '../../../src/storage/globalPresets.js';
