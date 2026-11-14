// Preload（design.md「IPC 契约」）：contextBridge 白名单，唯一通道。
//
// sandbox: true 下 preload 必须是 CommonJS，故文件名为 .cjs（Electron 的 ESM preload
// 只在非 sandbox 场景可用）。这里不 import 任何业务模块，只做通道映射与参数整形。
const { contextBridge, ipcRenderer } = require('electron');

// 同步路径：documentDirectory 在共享层是同步读取的（文件系统适配层的模块级常量）。
const paths = ipcRenderer.sendSync('app:paths');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// 同步 fs 通道（renderer 的 File/FileHandle 是同步语义，对齐 expo 新 API）。
const syncCall = (channel, ...args) => {
  const result = ipcRenderer.sendSync(channel, ...args);
  if (!result || result.ok !== true) {
    const error = new Error((result && result.message) || 'desktop sync fs call failed');
    error.code = (result && result.code) || 'FS_ERROR';
    throw error;
  }
  return result.value;
};

// http 事件（status/chunk/done/error/abort）广播给渲染层订阅者。
const httpSubscribers = new Set();
ipcRenderer.on('http:event', (event, payload) => {
  for (const subscriber of [...httpSubscribers]) {
    try {
      subscriber(payload);
    } catch (error) {
      // 订阅者异常不能打断其它订阅者与 IPC 通道。
    }
  }
});

// 系统通知点击：主进程把 payload 回传（含 characterId/sessionId），渲染层据此跳会话。
// 与 http:event 同一订阅范式，避免为一次性事件再造一套机制。
const notifyClickSubscribers = new Set();
ipcRenderer.on('notify:click', (event, payload) => {
  for (const subscriber of [...notifyClickSubscribers]) {
    try {
      subscriber(payload);
    } catch (error) {
      // 订阅者异常不能打断其它订阅者。
    }
  }
});

const bridge = {
  app: {
    paths,
    info: () => invoke('app:info'),
    openExternal: url => invoke('app:openExternal', url),
    openPath: uri => invoke('app:openPath', uri),
  },
  kv: {
    get: key => invoke('kv:get', key),
    set: (key, value) => invoke('kv:set', key, value),
    remove: key => invoke('kv:remove', key),
    keys: () => invoke('kv:keys'),
    multiGet: keys => invoke('kv:multiGet', keys),
    multiSet: entries => invoke('kv:multiSet', entries),
    multiRemove: keys => invoke('kv:multiRemove', keys),
  },
  fs: {
    stat: uri => invoke('fs:stat', uri),
    read: (uri, encoding) => invoke('fs:read', uri, encoding),
    write: (uri, data, encoding) => invoke('fs:write', uri, data, encoding),
    mkdir: (uri, intermediates) => invoke('fs:mkdir', uri, intermediates),
    readDir: uri => invoke('fs:readDir', uri),
    copy: (from, to) => invoke('fs:copy', from, to),
    move: (from, to) => invoke('fs:move', from, to),
    delete: (uri, idempotent) => invoke('fs:delete', uri, idempotent),
    download: (url, to) => invoke('fs:download', url, to),
    freeSpace: () => invoke('fs:freeSpace'),
    openHandle: uri => invoke('fs:openHandle', uri),
    readBytes: (handleId, length) => invoke('fs:readBytes', handleId, length),
    closeHandle: handleId => invoke('fs:closeHandle', handleId),
    sync: {
      stat: uri => syncCall('fs:sync:stat', uri),
      openHandle: uri => syncCall('fs:sync:openHandle', uri),
      readBytes: (handleId, length) => syncCall('fs:sync:readBytes', handleId, length),
      writeBytes: (handleId, bytes) => syncCall('fs:sync:writeBytes', handleId, bytes),
      closeHandle: handleId => syncCall('fs:sync:closeHandle', handleId),
      create: (uri, options) => syncCall('fs:sync:create', uri, options),
      writeAll: (uri, bytes) => syncCall('fs:sync:writeAll', uri, bytes),
      readAll: uri => syncCall('fs:sync:readAll', uri),
      delete: uri => syncCall('fs:sync:delete', uri),
    },
  },
  secret: {
    available: () => invoke('secret:available'),
    get: id => invoke('secret:get', id),
    set: (id, value) => invoke('secret:set', id, value),
    remove: id => invoke('secret:remove', id),
  },
  dialog: {
    alert: (title, message, buttons) => invoke('dialog:alert', title, message, buttons),
    open: (filters, multi) => invoke('dialog:open', filters, multi),
    save: (defaultName, filters) => invoke('dialog:save', defaultName, filters),
    reveal: target => invoke('dialog:reveal', target),
  },
  media: {
    // 用户主动选择文件：对话框与复制都在主进程完成，渲染层只拿到 documents/ 下的结果。
    pick: kind => invoke('media:pick', kind),
  },
  backup: {
    // 备份/角色卡：pick 选入并暂存到 cache，saveAs 把渲染层产物另存到用户选择的位置。
    pick: () => invoke('backup:pick'),
    saveAs: (sourceUri, defaultName, filters) => invoke('backup:saveAs', sourceUri, defaultName, filters),
    pickCard: () => invoke('card:pick'),
  },
  clipboard: {
    write: text => invoke('clipboard:write', text),
  },
  notify: {
    // 系统通知：桌面没有后台服务，窗口开着时到点提醒（诚实版的部分实现）。
    // payload 可带 target:{characterId,sessionId,messageId}，点击时回传给订阅方。
    show: payload => invoke('notify:show', payload),
    // 订阅「通知被点击」：返回取消订阅函数（与 http.onEvent 同一形态）。
    onClick: handler => {
      if (typeof handler !== 'function') return () => {};
      notifyClickSubscribers.add(handler);
      return () => { notifyClickSubscribers.delete(handler); };
    },
  },
  books: {
    // DOCX 解包：传 base64 字节，主进程用 node:zlib 取出 word/document.xml 的 XML 文本。
    // 正文抽取在渲染层做（共享纯函数 src/books/docxText.js）——主进程的打包白名单
    // 不含 src/，在这里 import 共享层会让打包版启动失败。
    docxXml: base64 => invoke('books:docxXml', { base64 }),
  },
  capture: {
    // 应用内截图（看屏幕 v1）：主进程 webContents.capturePage，零权限、只截本窗口。
    appScreen: () => invoke('capture:appScreen'),
  },
  http: {
    start: payload => invoke('http:start', payload),
    abort: requestId => invoke('http:abort', requestId),
    onEvent: subscriber => {
      httpSubscribers.add(subscriber);
      return () => httpSubscribers.delete(subscriber);
    },
  },
};

contextBridge.exposeInMainWorld('easychat2', bridge);
