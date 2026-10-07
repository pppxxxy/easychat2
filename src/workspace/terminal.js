// 终端面板的纯逻辑：cwd 解析、沙盒路径拼接、命令历史（零依赖，Node 直测）。
//
// 为什么 cd 由面板维护而不是交给 sh：每条命令都是**独立进程**（ShellExecutor 一次 exec
// 一个 /system/bin/sh），环境变量与工作目录都不跨命令保持。所以 cwd 只能由面板记住，
// 每次执行时作为 ProcessBuilder 的 working directory 传下去（见 shell.js 的 cwdPath）。

export const TERMINAL_HISTORY_LIMIT = 50;

// 把任意 cwd 写法归一成沙盒内相对路径：'' / '.' / '/' / '~' → '.'；'..' 不越界。
export function normalizeCwd(value) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '/' || text === '~') return '.';
  const segments = [];
  for (const part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  return segments.length ? segments.join('/') : '.';
}

// 识别 `cd <目标>`：返回 { changed: true, cwd }；不是 cd 就 changed:false。
// 目标是相对当前 cwd 解析的；以 / 开头按沙盒根解析（终端看不到真实文件系统，
// 不做「真的切到 /system」这种越界事）。
export function resolveTerminalCwd(current, command) {
  const text = String(command || '').trim();
  const match = text.match(/^cd(?:\s+(.*))?$/);
  const base = normalizeCwd(current);
  if (!match) return { changed: false, cwd: base };
  const raw = String(match[1] === undefined ? '' : match[1]).trim().replace(/^['"]|['"]$/g, '');
  if (!raw || raw === '~' || raw === '/') return { changed: true, cwd: '.' };
  const segments = raw.startsWith('/') ? [] : (base === '.' ? [] : base.split('/'));
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  return { changed: true, cwd: segments.length ? segments.join('/') : '.' };
}

// 沙盒绝对路径 + 相对 cwd → 真实工作目录（交给 ProcessBuilder）。
export function sandboxCwdPath(basePath, cwd) {
  const base = String(basePath || '').replace(/\/+$/, '');
  const rel = normalizeCwd(cwd);
  return rel === '.' ? base : `${base}/${rel}`;
}

// 命令历史：追加（连续重复只留一条）、上限裁剪（↑↓ 召回用）。
export function historyWithCommand(history, command, limit = TERMINAL_HISTORY_LIMIT) {
  const list = (Array.isArray(history) ? history : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  const text = String(command || '').trim();
  if (!text) return list.slice(-limit);
  const next = list.length && list[list.length - 1] === text ? list : [...list, text];
  return next.slice(-limit);
}
