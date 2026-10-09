// 命令执行工具定义（run_shell / run_python）。
//
// 本文件**零 import**：execute 走 options.shell / options.python（runner 由注册方
// 注入），真正的原生桥在 shell.js / python.js，那两处已各自惰性取原生模块、
// 顶层不求 react-native。拆开的意义是把「执行类工具是否存在」与「定义表加载」
// 解耦——不注册执行工具的会话（默认就是）连这两份定义都不必看见。
//
// 三层门控（与注册方一致）：不注册（开关关/外部根/原生缺失）→ 不进工具清单
// → 逐条确认（requiresConfirmation，第三层由 UI 弹框兜底）。

export const SHELL_TOOL_DEFINITION = {
  name: 'run_shell',
  description: '在应用私有工作区内执行一条 shell（sh）命令。仅「可改」模式且用户开启命令执行时可用，每条命令都会先请用户确认。注意：它只能访问应用自己的沙盒与系统公开路径，看不到你选的手机文件夹；输出过大时会截断。',
  readOnly: false,
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（经 /system/bin/sh -c 执行）。' },
    },
    required: ['command'],
  },
  execute: (options, args, ctx) => options.shell.run({
    command: args.command,
    signal: ctx && ctx.signal,
    characterId: ctx && ctx.characterId,
  }),
};

// Python 执行工具。与 run_shell 同一套三层门控，差别在两处：
// 1) 它需要**另一个开关**（允许模型运行 Python）——Python 能联网、能读整个应用沙盒，
//    与 shell 是两条独立的执行面，不该共用一个开关；
// 2) 脚本跑在独立进程里（:python），超时会被强杀——所以模型用它不会把应用占死。
export const PYTHON_TOOL_DEFINITION = {
  name: 'run_python',
  description: '在应用私有工作区中执行一段 Python 代码（Chaquopy 内置 CPython）。仅「可改」模式且用户开启「允许模型运行 Python」时可用，每次执行都会先请用户确认。没有运行时 pip，只能用已打进包的库（requests 等）；工作目录是该角色的工作区子目录；脚本在独立进程里运行，超时会被强制终止，输出过大时会截断。',
  readOnly: false,
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的 Python 代码（单段脚本，不是交互式会话；每次执行的状态不保留）。' },
    },
    required: ['code'],
  },
  execute: (options, args, ctx) => options.python.run({
    code: args.code,
    signal: ctx && ctx.signal,
    characterId: ctx && ctx.characterId,
  }),
};
