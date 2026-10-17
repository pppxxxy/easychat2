// `expo-file-system/legacy` 的 Node 端桩（内存 URI → 内容映射）。
//
// 语义对齐 legacy API 里 App 实际依赖的部分：
//   - readAsStringAsync 读不到 → 抛（真实实现也抛，不返回 null）
//   - getInfoAsync 读不到 → { exists: false }（真实实现不抛）
//   - deleteAsync 默认 idempotent=true（删不存在的文件不抛）
// 这三条差异是 App 里 catch 分支的判据，桩必须一致，否则错误路径测不出来。

let files = new Map();
let directories = new Set();
let failReadUris = new Set();
let failWriteUris = new Set();
const calls = { read: 0, write: 0, delete: 0, info: 0, readDir: 0, mkdir: 0 };

function dirOf(uri) {
  const text = String(uri);
  const index = text.lastIndexOf('/');
  return index <= 0 ? '' : text.slice(0, index);
}

const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  bundleDirectory: 'file:///bundle/',
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },

  async getInfoAsync(uri) {
    calls.info += 1;
    if (files.has(uri)) {
      const content = files.get(uri);
      return { exists: true, isDirectory: false, uri, size: String(content).length, modificationTime: 0 };
    }
    if (directories.has(uri)) return { exists: true, isDirectory: true, uri, size: 0, modificationTime: 0 };
    return { exists: false, isDirectory: false, uri };
  },

  async readAsStringAsync(uri) {
    calls.read += 1;
    if (failReadUris.has(uri)) throw new Error(`legacy readAsStringAsync failed: ${uri}`);
    if (!files.has(uri)) throw new Error(`legacy readAsStringAsync: missing file ${uri}`);
    return files.get(uri);
  },

  async writeAsStringAsync(uri, content) {
    calls.write += 1;
    if (failWriteUris.has(uri)) throw new Error(`legacy writeAsStringAsync failed: ${uri}`);
    files.set(uri, String(content));
    directories.add(dirOf(uri));
  },

  async deleteAsync(uri, options) {
    calls.delete += 1;
    const idempotent = !options || options.idempotent !== false;
    if (!files.has(uri) && !directories.has(uri) && !idempotent) {
      throw new Error(`legacy deleteAsync: missing ${uri}`);
    }
    files.delete(uri);
    directories.delete(uri);
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${uri}/`)) files.delete(key);
    }
  },

  async makeDirectoryAsync(uri) {
    calls.mkdir += 1;
    directories.add(uri);
  },

  async readDirectoryAsync(uri) {
    calls.readDir += 1;
    const prefix = String(uri).endsWith('/') ? String(uri) : `${uri}/`;
    const names = new Set();
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        names.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
      }
    }
    return [...names];
  },

  async copyAsync({ from, to }) {
    if (!files.has(from)) throw new Error(`legacy copyAsync: missing ${from}`);
    files.set(to, files.get(from));
  },

  async moveAsync({ from, to }) {
    if (!files.has(from)) throw new Error(`legacy moveAsync: missing ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },

  async downloadAsync(url, to) {
    files.set(to, `downloaded:${url}`);
    return { uri: to, status: 200 };
  },
};

export default FileSystem;

// ---- 测试自省与编程接口 ----
export function __reset() {
  files = new Map();
  directories = new Set();
  failReadUris = new Set();
  failWriteUris = new Set();
  for (const key of Object.keys(calls)) calls[key] = 0;
}

export function __files() {
  return new Map(files);
}

export function __seed(entries) {
  for (const [uri, content] of Object.entries(entries)) {
    files.set(uri, String(content));
    directories.add(dirOf(uri));
  }
}

export function __calls() {
  return calls;
}

export function __failRead(uris) {
  for (const uri of uris) failReadUris.add(uri);
}

export function __failWrite(uris) {
  for (const uri of uris) failWriteUris.add(uri);
}
