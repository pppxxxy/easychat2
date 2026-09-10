const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// parsecard 通过 package.json 的 exports 暴露 ESM 入口，Metro 默认不读取 exports，
// 因此这里全局开启。注意该开关对所有依赖生效，升级或新增依赖后需重新验证打包结果。
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['require', 'import', 'react-native', 'browser', 'default'];

module.exports = config;
