// 人类可读的体积（日志里展示模型文件大小 / 设备内存，UI 展示下载进度）。
// 此前在 LocalModelPanel / modelLogs / ModelSearchModal / ModelPanelModal 各有一份
// 逐字相同的实现（2026-10-06 指令书 C5 收敛），现在统一从这里引用。

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)}${units[index]}`;
}
