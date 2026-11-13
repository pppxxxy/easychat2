// 冒烟探针（由主进程用 webContents.executeJavaScript 注入渲染进程执行）。
//
// S1 链路：window.easychat2 -> kv/fs -> 磁盘。
// S2 链路：AppProvider 挂载 -> 读取角色库/会话 -> 诊断钩子 window.__easychat2S2。
(async () => {
  const waitFor = async (read, timeoutMs = 12000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  };

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

  const artwork = await bridge.fs.stat(dir + 'avatars/default-assistant-avatar.jpg');
  const avatarsList = await bridge.fs.readDir(dir + 'avatars').catch(error => `ERR:${error.code || error.message}`);
  const s2 = await waitFor(() => window.__easychat2S2);
  const keys = await bridge.kv.keys();
  const hasCharactersKey = keys.includes('@easychat2_character_index');
  const hasSessionsKey = keys.includes('@easychat2_sessions');

  return {
    bridge: true,
    kv: kvValue,
    fs: fsText,
    exists: !!stat.exists,
    syncExists: !!sync.exists,
    xhr: typeof XMLHttpRequest === 'function',
    version: info && info.version,
    documents: dir,
    artworkExists: !!(artwork && artwork.exists),
    artworkRaw: artwork,
    avatarsList,
    s2,
    storage: { hasCharactersKey, hasSessionsKey, keyCount: keys.length },
  };
})()
