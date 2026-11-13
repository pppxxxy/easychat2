// expo-file-system/legacy 适配（design.md「适配层契约 2」）：覆盖共享层用到的全部成员。
//
// 共享层两种导入方式都会出现：
//   · `import * as FileSystem from 'expo-file-system/legacy'`（多数）
//   · `import { documentDirectory, getInfoAsync } from 'expo-file-system/legacy'`（storage/io、payload…）
// 因此本模块同时提供 default 与**命名导出**。命名导出用「惰性绑定」实现：
// 渲染进程里 window.easychat2 在页面脚本前就绪，模块加载时即可初始化；
// Node 测试里没有 window，命名导出保持占位，测试只用 createFileSystem(bridge) 工厂。
export function createFileSystem(bridge) {
  const fs = bridge.fs;
  const paths = bridge.app.paths;
  return {
    documentDirectory: paths.documentDirectory,
    cacheDirectory: paths.cacheDirectory,
    EncodingType: Object.freeze({ UTF8: 'utf8', Base64: 'base64' }),
    getInfoAsync: async uri => fs.stat(uri),
    readAsStringAsync: async (uri, options) => fs.read(uri, options && options.encoding ? options.encoding : 'utf8'),
    writeAsStringAsync: async (uri, data, options) => fs.write(uri, data, options && options.encoding ? options.encoding : 'utf8'),
    makeDirectoryAsync: async (uri, options) => fs.mkdir(uri, !!(options && options.intermediates)),
    readDirectoryAsync: async uri => fs.readDir(uri),
    copyAsync: async ({ from, to }) => fs.copy(from, to),
    moveAsync: async ({ from, to }) => fs.move(from, to),
    deleteAsync: async (uri, options) => fs.delete(uri, !(options && options.idempotent === false)),
    downloadAsync: async (url, to) => fs.download(url, to),
    getFreeDiskStorageAsync: async () => fs.freeSpace(),
    // types 是 expo 的类型命名空间载体（运行时无意义），保留空对象以兼容 import 形状。
    types: Object.freeze({}),
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createFileSystem(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const documentDirectory = instance ? instance.documentDirectory : '';
export const cacheDirectory = instance ? instance.cacheDirectory : '';
export const EncodingType = Object.freeze({ UTF8: 'utf8', Base64: 'base64' });
export const types = Object.freeze({});
export const getInfoAsync = (...args) => ensure().getInfoAsync(...args);
export const readAsStringAsync = (...args) => ensure().readAsStringAsync(...args);
export const writeAsStringAsync = (...args) => ensure().writeAsStringAsync(...args);
export const makeDirectoryAsync = (...args) => ensure().makeDirectoryAsync(...args);
export const readDirectoryAsync = (...args) => ensure().readDirectoryAsync(...args);
export const copyAsync = (...args) => ensure().copyAsync(...args);
export const moveAsync = (...args) => ensure().moveAsync(...args);
export const deleteAsync = (...args) => ensure().deleteAsync(...args);
export const downloadAsync = (...args) => ensure().downloadAsync(...args);
export const getFreeDiskStorageAsync = (...args) => ensure().getFreeDiskStorageAsync(...args);

export default instance || {
  documentDirectory,
  cacheDirectory,
  EncodingType,
  types,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
  makeDirectoryAsync,
  readDirectoryAsync,
  copyAsync,
  moveAsync,
  deleteAsync,
  downloadAsync,
  getFreeDiskStorageAsync,
};
