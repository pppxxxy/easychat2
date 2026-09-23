const { withGradleProperties } = require('@expo/config-plugins');

// AsyncStorage 在 Android 上的 SQLite 默认上限是 6MB（react-native-async-storage 的
// android/config.gradle 读取 gradle 属性 AsyncStorage_db_size_in_MB）。角色卡、消息、
// 记忆等文本数据超过后写入会失败。这里在 prebuild 时把上限写进 android/gradle.properties，
// 保证 `expo prebuild --clean` 重新生成后依然生效。
const PROP_KEY = 'AsyncStorage_db_size_in_MB';

module.exports = function withAsyncStorageDbSize(config, { sizeMB = 1024 } = {}) {
  const value = String(Number.isFinite(Number(sizeMB)) && Number(sizeMB) > 0 ? Math.floor(Number(sizeMB)) : 1024);
  return withGradleProperties(config, cfg => {
    const props = Array.isArray(cfg.modResults) ? cfg.modResults : [];
    const existing = props.find(
      item => item && item.type === 'property' && item.key === PROP_KEY
    );
    if (existing) {
      existing.value = value;
    } else {
      props.push({ type: 'property', key: PROP_KEY, value });
    }
    cfg.modResults = props;
    return cfg;
  });
};
