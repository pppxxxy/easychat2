// expo-file-system/legacy 适配（design.md「适配层契约 2」）：覆盖共享层用到的全部成员。
//
// documentDirectory / cacheDirectory 必须是**同步常量**（共享层模块级字符串拼接），
// 由 preload 在加载期用 sendSync 取得；其余成员映射到主进程异步 fs 通道。
// 注意 EncodingType 的取值与 expo 一致：UTF8='utf8'、Base64='base64'。
import { createLazyDefault } from './bridge.js';

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

export default createLazyDefault(createFileSystem);
