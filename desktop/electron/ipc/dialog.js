// 对话框与剪贴板（design.md「适配层契约 6」+ IPC 表）。
//
// 注意：渲染层的 Alert 是**应用内模态**（React 组件，见 src/platform/alert.js），
// 不走这里；dialog:alert 保留给主进程侧需要原生模态的场景（如启动失败弹窗）。
// 文件选择/保存/在文件夹中显示是需要原生能力的部分，只能走主进程。
import path from 'node:path';

export function registerDialogIpc(ipcMain, { dialog, shell, clipboard, resolver } = {}) {
  const requireResolver = resolver || null;
  const check = (target, { allowOutside = false } = {}) => {
    // reveal 的目标可能来自系统（用户刚保存的路径），但仍先归一化；
    // 选择/保存的返回值由主进程产生，天然可信。
    if (!requireResolver || allowOutside) return String(target);
    if (!requireResolver.isInside(target)) {
      const error = new Error('Path is outside the allowed roots');
      error.code = 'PATH_OUTSIDE_ROOT';
      throw error;
    }
    return String(target);
  };

  ipcMain.handle('dialog:alert', async (event, title, message, buttons) => {
    const list = Array.isArray(buttons) && buttons.length > 0
      ? buttons
      : [{ text: 'OK', style: 'default' }];
    const result = await dialog.showMessageBox({
      type: 'info',
      title: String(title || ''),
      message: String(message || ''),
      buttons: list.map(button => String(button.text || '')),
      cancelId: Math.max(0, list.findIndex(button => button.style === 'cancel')),
    });
    return result.response;
  });

  ipcMain.handle('dialog:open', async (event, filters, multi) => {
    const result = await dialog.showOpenDialog({
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: Array.isArray(filters) ? filters : undefined,
    });
    return {
      canceled: result.canceled,
      files: (result.filePaths || []).map(filePath => ({ name: path.basename(filePath), path: filePath })),
    };
  });

  ipcMain.handle('dialog:save', async (event, defaultName, filters) => {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName ? String(defaultName) : undefined,
      filters: Array.isArray(filters) ? filters : undefined,
    });
    return { canceled: result.canceled, path: result.filePath || '' };
  });

  ipcMain.handle('dialog:reveal', (event, target) => {
    shell.showItemInFolder(check(target, { allowOutside: true }));
  });

  ipcMain.handle('clipboard:write', (event, text) => {
    clipboard.writeText(String(text ?? ''));
  });
}
