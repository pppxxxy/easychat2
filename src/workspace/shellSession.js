// 持久 shell 会话（方案 B，spec 2026-10-09-agent-extensibility T7）。
//
// 目标：命令之间不再「每次都从工作区根开始」——**记住 cd 后的目录**，并支持一组
// 持久环境变量。实现刻意**不引入 PTY / 常驻进程**（成本不成比例：常驻进程要处理
// 生命周期、僵尸进程、输出流缓冲、与 app 后台被杀的关系；PTY 更是整块新原生能力），
// 走「状态存在文件里」的方案 B：
//
// - `.easychat/env.json`（agent 可读写，与 AGENTS.md/skills 同一「文件即状态」哲学）：
//     { "cwd": "src", "env": { "FOO": "bar" } }
//   cwd 是**沙盒内的相对路径**；env 是要注入每次执行的变量。
// - 捕获「命令跑完在哪个目录」：把命令包装成
//     <env 前缀> / mkdir .easychat / cd 上次目录（失效回落根） / <用户命令>
//     __easyec=$? / pwd > <根>/.easychat/.shell-cwd / exit $__easyec
//   执行后读 `.shell-cwd` 回写 env.json——**退出码原样保留**，捕获不改变命令语义。
// - 逃逸防护：捕获到的目录**不在沙盒内**就不记住（`cd /` 之后所有命令都在 / 下跑
//   是比不记忆更糟的体验）；cwd 里含 `..` 一律丢弃（逃逸意图直接不记）。
// - 与终端面板共享同一份 env.json：用户在终端里 cd 到 src，模型下一次 run_shell
//   就在 src；反之亦然。终端自己的 cd 拦截仍负责即时体验，两边最后都落到这个文件。
//
// PTY / 完整交互式会话（vim、top 这类需要终端的程序）登记为待办，不在本方案内——
// capabilities 能力说明里如实告知用户边界。

export const SHELL_ENV_FILE = '.easychat/env.json';
// 捕获文件：临时状态，用完不删（每次覆盖写，少一次删除 IO；点开头文件在隐藏目录里）。
export const SHELL_CWD_FILE = '.easychat/.shell-cwd';
export const SHELL_CWD_MAX = 200;
export const SHELL_ENV_MAX_KEYS = 20;
export const SHELL_ENV_VALUE_MAX = 500;
const SHELL_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 纯函数：cwd 归一为「沙盒内相对路径」（'' = 根）。含 ..、绝对路径、超长一律丢弃。
export function sanitizeShellCwd(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === './') return '';
  if (raw.length > SHELL_CWD_MAX) return '';
  if (raw.startsWith('/')) return ''; // 绝对路径不是沙盒内的相对路径
  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return ''; // 含 .. 一律不记（逃逸意图）
    segments.push(segment);
  }
  return segments.join('/');
}

// 纯函数：env.json 文本（或已解析对象）→ { cwd, env }。坏格式一律安全降级。
export function parseShellEnv(text) {
  const empty = { cwd: '', env: {} };
  let source = text;
  if (typeof text === 'string') {
    try {
      source = JSON.parse(text);
    } catch (error) {
      return empty;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return empty;
  const cwd = sanitizeShellCwd(source.cwd);
  const rawEnv = source.env && typeof source.env === 'object' && !Array.isArray(source.env) ? source.env : {};
  const env = {};
  let count = 0;
  for (const [key, value] of Object.entries(rawEnv)) {
    if (count >= SHELL_ENV_MAX_KEYS) break;
    const name = String(key || '').trim();
    if (!SHELL_ENV_KEY_PATTERN.test(name)) continue; // 非法变量名进不了 shell，也不进存储
    const content = String(value == null ? '' : value);
    if (!content) continue;
    env[name] = content.slice(0, SHELL_ENV_VALUE_MAX);
    count += 1;
  }
  return { cwd, env };
}

// 单引号包裹的 shell 参数（' 用 '\'' 转义）——拼进脚本的任何外部字符串都走这里。
function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

// 纯函数：环境变量的 export 前缀（空 env → 空串）。键名已在 parse 阶段洗过。
export function shellEnvExports(env) {
  const source = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  const names = Object.keys(source)
    .filter(name => SHELL_ENV_KEY_PATTERN.test(name))
    .slice(0, SHELL_ENV_MAX_KEYS);
  if (names.length === 0) return '';
  return names.map(name => `export ${name}=${shellQuote(source[name])}`).join('\n');
}

// 纯函数：把用户命令包装成「重放目录 + 捕获结束目录 + 保留退出码」的脚本。
// 捕获写的是**绝对路径**——写入时 cwd 已经变了，相对路径会写错地方。
export function wrapShellCommand({ command, rootPath, cwd, env } = {}) {
  const root = String(rootPath == null ? '' : rootPath).replace(/\/+$/, '');
  const body = String(command == null ? '' : command).trim();
  const parts = [];
  const exports = shellEnvExports(env);
  if (exports) parts.push(exports);
  parts.push(`mkdir -p ${shellQuote(`${root}/.easychat`)} 2>/dev/null`);
  const safeCwd = sanitizeShellCwd(cwd);
  if (safeCwd) {
    parts.push(`cd ${shellQuote(`${root}/${safeCwd}`)} 2>/dev/null || cd ${shellQuote(root)}`);
  } else {
    parts.push(`cd ${shellQuote(root)} 2>/dev/null`);
  }
  parts.push(body);
  // 退出码必须在任何后续语句前抓下来；变量名带冷僻前缀，避免撞上用户脚本里的名字。
  parts.push('__easyec=$?');
  parts.push(`pwd > ${shellQuote(`${root}/${SHELL_CWD_FILE}`)} 2>/dev/null`);
  parts.push('exit $__easyec');
  return parts.join('\n');
}

// 纯函数：`.shell-cwd` 的内容（绝对路径）+ 沙盒根 → 相对 cwd。
// 返回 ''（在根）、'src'（子目录）或 **null（不在沙盒内——不记住，保持原值）**。
export function resolveCapturedCwd(pwdOutput, rootPath) {
  const raw = String(pwdOutput == null ? '' : pwdOutput).trim();
  if (!raw) return null;
  // 取最后一行（命令自己也可能往这个文件…不会，但防御多行异常）。
  const last = raw.split('\n').filter(line => line.trim()).pop() || '';
  const root = String(rootPath == null ? '' : rootPath).replace(/\/+$/, '');
  const value = last.trim().replace(/\/+$/, '');
  if (!root || !value) return null;
  if (value === root) return '';
  if (!value.startsWith(`${root}/`)) return null; // 逃出沙盒：不记住
  return sanitizeShellCwd(value.slice(root.length + 1));
}

// IO：读会话状态（不存在/读失败/坏格式 → 空）。
export async function readShellSession(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return { cwd: '', env: {} };
  try {
    const result = await store.readWorkspaceFile({ characterId, path: SHELL_ENV_FILE });
    return parseShellEnv(result && result.content);
  } catch (error) {
    return { cwd: '', env: {} };
  }
}

// IO：写会话状态（写入前再洗一遍——调用方传脏值也不会污染文件）。失败静默。
export async function writeShellSession(store, characterId, session) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return false;
  const clean = parseShellEnv({
    cwd: session && session.cwd,
    env: session && session.env,
  });
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: SHELL_ENV_FILE,
      content: `${JSON.stringify(clean, null, 2)}\n`,
    });
    return true;
  } catch (error) {
    return false;
  }
}
