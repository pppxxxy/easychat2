// 本地 git 的展示用纯函数（与 RN 组件分开，Node 可直测）。
//
// 为什么不放进面板组件：面板 import react-native，Node 进不去；纯格式化逻辑一旦长在里面
// 就只能靠源码断言。这里是「能被单测钉住的那一半」。

// 提交时间：本地时区的 YYYY-MM-DD HH:mm。
// 不用 Intl：RN 各平台的 Intl 支持不一致（Hermes 上尤其），自己拼更可控。
export function formatCommitTime(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = part => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 提交里单个文件的改动记号（与 git status --short 的字母一致，好认）。
export const COMMIT_FILE_MARKS = Object.freeze({ added: 'A', modified: 'M', deleted: 'D' });

export function commitFileMark(status) {
  return COMMIT_FILE_MARKS[status] || '?';
}
