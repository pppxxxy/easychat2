// 系统通知（Electron Notification）。
//
// 手机侧主动消息通过原生 AlarmReceiver + 系统通知投递；桌面没有后台服务，
// 但应用在前台时仍可以弹出系统通知——这是「诚实版」的部分实现：
// 不承诺进程退出后还能到点，只承诺「窗口开着时到点就提醒」。
//
// 只暴露一个通道，且**不接收任意图标/动作**：标题与正文都来自渲染层已脱敏的文案，
// 主进程只负责投递（点击时把窗口带到前台）。
export function registerNotifyIpc(ipcMain, { Notification, getWindow } = {}) {
  if (typeof Notification !== 'function' || !Notification.isSupported || !Notification.isSupported()) {
    // 环境不支持（极少见）：仍注册通道，调用方拿到 ok:false 并据此回落到应用内提示。
    ipcMain.handle('notify:show', async () => ({ ok: false, reason: 'unsupported' }));
    return;
  }
  ipcMain.handle('notify:show', async (event, payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const title = String(source.title || '').slice(0, 120);
    const body = String(source.body || '').slice(0, 400);
    if (!title && !body) return { ok: false, reason: 'empty' };
    try {
      const notification = new Notification({ title: title || 'EasyChat2', body, silent: false });
      // 跳转目标由渲染层给（主动消息会带 characterId/sessionId）。主进程不解释业务字段，
      // 只做两件事：把窗口带到前台，再把 payload 原样回传给渲染层去导航。
      const target = source.target && typeof source.target === 'object' ? {
        characterId: String(source.target.characterId || ''),
        sessionId: String(source.target.sessionId || ''),
        messageId: String(source.target.messageId || ''),
      } : null;
      notification.on('click', () => {
        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win) {
          if (win.isMinimized && win.isMinimized()) win.restore();
          if (win.show) win.show();
          if (win.focus) win.focus();
          // 回传给渲染层：让它切角色/会话。窗口不存在时也照发，渲染层会自己排队。
          if (target && win.webContents && win.webContents.send) {
            win.webContents.send('notify:click', target);
          }
        }
      });
      notification.show();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });
}
