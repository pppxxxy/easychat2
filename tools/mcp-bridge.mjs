#!/usr/bin/env node
// easychat2 内置 MCP Server 的**本地 CLI 桥**。
//
// 为什么需要它：DeepSeek Harness（以及任何没有原生 MCP 客户端能力的宿主）的工具表是
// 固定的，无法在运行时动态注册一个 MCP 服务器。但宿主能执行命令——所以把 MCP 调用
// 收敛成一条 CLI，宿主用 shell 调它即可，等价于「接入」。
//
// 它复用 App 自己的 src/mcp/client.js（纯 JS、零 RN 依赖、Node 可直测），
// 不是另写一份协议实现——协议只有一份，两边行为不会漂移。
//
// 用法：
//   node tools/mcp-bridge.mjs --url http://192.168.1.5:8737/mcp --token <token> ping
//   node tools/mcp-bridge.mjs ... list
//   node tools/mcp-bridge.mjs ... call <tool> [--args-file <json 文件>]
//   node tools/mcp-bridge.mjs ... docs
//
// 退出码：0 成功；1 调用/协议失败；2 参数错误；3 连接失败（网络不可达）。
// 输出：stdout 只放结果 JSON（便于宿主解析），人读的提示走 stderr。

import fs from 'node:fs';

import { createMcpSession } from '../src/mcp/client.js';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHABLE = 3;

function parseArgv(argv) {
  const out = { url: '', token: '', timeoutMs: 0, argsFile: '', positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') { out.url = String(argv[++i] || ''); continue; }
    if (arg === '--token') { out.token = String(argv[++i] || ''); continue; }
    if (arg === '--timeout') { out.timeoutMs = Number(argv[++i] || 0); continue; }
    if (arg === '--args-file') { out.argsFile = String(argv[++i] || ''); continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    out.positional.push(arg);
  }
  return out;
}

const USAGE = `easychat2 MCP 本地桥

  node tools/mcp-bridge.mjs --url <http://ip:port/mcp> --token <bearer> <命令>

命令：
  ping                握手 + 列工具，确认连通（不需要工具档位）
  list                列出工具（含风险档位）
  call <name>         调用工具；参数用 --args-file 传 JSON 对象（推荐）
  docs                读 App 自带的 resources 文档（tools/write-safety/access/workspace）
  resources           列出 resources

退出码：0 成功 / 1 失败 / 2 参数错 / 3 连不上`;

// 退出**不走 process.exit()**：在 Windows 上，stdout 是管道时写入是异步的，
// process.exit() 会在刷完之前强行终止，触发 libuv 断言
// （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c line 94`），
// 实测退出码变成 0xC0000409 且**调用方拿到空 stdout**——比崩溃本身更糟。
// 正确做法：设 process.exitCode，让事件循环自然排空后再退。
function emit(code, payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = code;
}

function fail(code, message, extra) {
  emit(code, { ok: false, code, message, ...(extra || {}) });
}

// 把底层网络错误翻译成「能不能连上」这个二元结论：
// fetch 的 TypeError('fetch failed') 对用户毫无信息量，真正的原因在 cause.code 里
// （ECONNREFUSED / EHOSTUNREACH / ENOTFOUND / ETIMEDOUT）。
function describeNetworkError(error) {
  const cause = error && error.cause;
  const code = String((cause && cause.code) || (error && error.code) || '');
  const map = {
    ECONNREFUSED: '端口没开或服务未启动（检查 App 里「启用服务器」是否真的开着）',
    EHOSTUNREACH: '主机不可达（多半不在同一局域网，或手机热点隔离）',
    ENETUNREACH: '网络不可达（检查 PC 与手机是否同一网段）',
    ETIMEDOUT: '连接超时（防火墙 / AP 隔离 / IP 写错）',
    ENOTFOUND: '域名解析失败（这里应该直接用 IP）',
  };
  return { code, hint: map[code] || '未知网络错误' };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${USAGE}\n`); return; }
  if (!args.url) { fail(EXIT_USAGE, '缺少 --url', { usage: USAGE }); return; }
  if (!args.token) { fail(EXIT_USAGE, '缺少 --token', { usage: USAGE }); return; }

  const [command = 'ping', ...rest] = args.positional;
  const session = createMcpSession({
    endpoint: args.url,
    token: args.token,
    timeoutMs: args.timeoutMs > 0 ? args.timeoutMs : 30000,
    clientInfo: { name: 'dsh-mcp-bridge', version: '1.0.0' },
  });

  try {
    if (command === 'ping') {
      const tools = await session.listTools();
      emit(EXIT_OK, {
        ok: true,
        reachable: true,
        toolCount: tools.length,
        tools: tools.map(tool => tool && tool.name).filter(Boolean),
      });
      return;
    }
    if (command === 'list') {
      const tools = await session.listTools();
      emit(EXIT_OK, { ok: true, tools });
      return;
    }
    if (command === 'resources') {
      const resources = await session.listResources();
      emit(EXIT_OK, { ok: true, resources });
      return;
    }
    if (command === 'docs') {
      // resources/read 用 easychat:// 前缀；一次读四份，缺哪份就跳过（不整体失败）。
      const uris = [
        'easychat://docs/tools',
        'easychat://docs/write-safety',
        'easychat://docs/access',
        'easychat://docs/workspace',
      ];
      const docs = {};
      for (const uri of uris) {
        try {
          const result = await session.readResource(uri);
          const first = result && Array.isArray(result.contents) ? result.contents[0] : null;
          docs[uri] = first ? String(first.text || '') : '';
        } catch (error) {
          docs[uri] = `__error__: ${String((error && error.message) || error)}`;
        }
      }
      emit(EXIT_OK, { ok: true, docs });
      return;
    }
    if (command === 'call') {
      const name = String(rest[0] || '');
      if (!name) { fail(EXIT_USAGE, 'call 需要工具名', { usage: USAGE }); return; }
      // 参数来源三选一（优先级从高到低）：
      //   1) --args-file <path>  —— 推荐。PowerShell 会把命令行里的 " 吃掉，
      //      内联 JSON 在 Windows 上基本不可靠（实测 `'{"path":"x"}'` 传进来变成 {path:x}）；
      //   2) 内联 JSON 字符串；
      //   3) 省略 = 空对象。
      let rawArgs = '';
      if (args.argsFile) {
        try {
          // 去 BOM：Windows 上 `Out-File -Encoding utf8` 默认写 BOM（EF BB BF），
          // JSON.parse 见到它直接报 "Unexpected token"。这是真实使用中最容易踩的一脚
          // （实测：文件内容看起来完全正常，就是解析不了），所以在读入处就剥掉。
          rawArgs = fs.readFileSync(args.argsFile, 'utf8').replace(/^\uFEFF/, '');
        } catch (error) {
          fail(EXIT_USAGE, `读不到参数文件 ${args.argsFile}：${String((error && error.message) || error)}`);
          return;
        }
      } else if (rest[1]) {
        rawArgs = rest[1];
      }
      let parsed = {};
      if (rawArgs && rawArgs.trim()) {
        try {
          parsed = JSON.parse(rawArgs);
        } catch (error) {
          fail(EXIT_USAGE, `参数不是合法 JSON：${String((error && error.message) || error)}`);
          return;
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(EXIT_USAGE, '参数必须是 JSON 对象（不能是数组或标量）');
        return;
      }
      const result = await session.callTool(name, parsed);
      const isError = Boolean(result && result.isError);
      emit(isError ? EXIT_FAIL : EXIT_OK, { ok: !isError, result });
      return;
    }
    fail(EXIT_USAGE, `未知命令：${command}`, { usage: USAGE });
  } catch (error) {
    const message = String((error && error.message) || error);
    const code = String((error && error.code) || '');
    // 协议层错误（服务端明确回了 JSON-RPC error）不算「连不上」，只有 fetch 层失败才是。
    const isNetwork = error instanceof TypeError || /fetch failed/i.test(message);
    if (isNetwork) {
      const { code: netCode, hint } = describeNetworkError(error);
      fail(EXIT_UNREACHABLE, message, { networkCode: netCode, hint });
      return;
    }
    fail(EXIT_FAIL, message, { code });
  }
}

main().catch(error => {
  fail(EXIT_FAIL, String((error && error.stack) || error));
});
