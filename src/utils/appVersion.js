// 应用版本号的单一读取点（app.json 的 expo.version，经 expo-constants 取运行时值）。
// 抽出来是为了让「检测更新」跳转与「应用内公告」的版本比对**同源**——
// 两处各写一遍 expoConfig 取值，迟早会因为一处加了兜底而分叉。
import Constants from 'expo-constants';

export const APP_VERSION = Constants.expoConfig ? String(Constants.expoConfig.version || '') : '';
