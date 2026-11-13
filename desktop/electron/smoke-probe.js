// 冒烟探针（由主进程用 webContents.executeJavaScript 注入渲染进程执行）。
//
// 验证的是 S1 的完整链路：渲染进程 -> preload 白名单 -> 主进程服务 -> 磁盘。
// 返回对象会随 SMOKE_RESULT 打印；任何一步失败都会体现在字段里。
(async () => {
  const bridge = window.easychat2;
  if (!bridge) return { bridge: false };
  const dir = bridge.app.paths.documentDirectory;
  const key = '@easychat2_smoke_test';
  await bridge.kv.set(key, 'ok');
  const kvValue = await bridge.kv.get(key);
  await bridge.kv.remove(key);
  await bridge.fs.write(dir + 'smoke.txt', 'hello');
  const fsText = await bridge.fs.read(dir + 'smoke.txt', 'utf8');
  const stat = await bridge.fs.stat(dir + 'smoke.txt');
  const sync = bridge.fs.sync.stat(dir + 'smoke.txt');
  const info = await bridge.app.info();
  return {
    bridge: true,
    kv: kvValue,
    fs: fsText,
    exists: !!stat.exists,
    syncExists: !!sync.exists,
    xhr: typeof XMLHttpRequest === 'function',
    version: info && info.version,
    documents: dir,
  };
})()
