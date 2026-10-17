// `expo-file-system`（新 API：File / Directory / Paths）的 Node 端桩。
//
// 真实模块是原生模块，Node 里 import 直接抛。仓库里对**新 API** 的使用点很少
// （`from 'expo-file-system'` 只有 src/storage/backup.js 的 File），
// 所以这里只实现被用到的形状，其余抛出「未打桩」——**宁可炸也不静默给假数据**，
// 否则测试会绿得没有意义。

class File {
  constructor(...parts) {
    this.uri = parts
      .map(item => (typeof item === 'string' ? item : (item && item.uri) || ''))
      .join('/');
    this._exists = false;
    this._content = null;
  }

  get exists() {
    return this._exists;
  }

  create() {
    this._exists = true;
  }

  write(content) {
    this._exists = true;
    this._content = content;
  }

  text() {
    if (!this._exists) throw new Error(`File not found: ${this.uri}`);
    return this._content == null ? '' : this._content;
  }

  delete() {
    this._exists = false;
    this._content = null;
  }

  copy() {
    throw new Error('expo-file-system 桩：File.copy 未实现（当前仓库未使用）');
  }

  move() {
    throw new Error('expo-file-system 桩：File.move 未实现（当前仓库未使用）');
  }
}

class Directory {
  constructor(...parts) {
    this.uri = parts
      .map(item => (typeof item === 'string' ? item : (item && item.uri) || ''))
      .join('/');
    this.exists = false;
  }

  create() {
    this.exists = true;
  }

  delete() {
    this.exists = false;
  }
}

const Paths = {
  document: 'file:///documents/',
  cache: 'file:///cache/',
  bundle: 'file:///bundle/',
};

export { File, Directory, Paths };
export default { File, Directory, Paths };
