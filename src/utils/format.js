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

// 「已运行多久」——长任务（team/workflow 的 timeoutMs=600000）的进度提示用。
// 毫秒 → m:ss（0:07 / 1:23 / 12:05）；满一小时进位成 h:mm:ss。
// 非法值/负数一律按 0 处理：宁可显示 0:00，也不要 NaN 或负号。
export function formatElapsed(value) {
  const ms = Number(value);
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const pad = n => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
