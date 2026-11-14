// 桌面外壳结构守卫（S34）：长时运行行为审计（超长会话 / 超大备份 / 日志累积）。
//
// 结论：
//   1. **超长会话 → 查出真缺口并修复**。手机 MessageList 有窗口化（只渲染尾部
//      MESSAGE_WINDOW_INITIAL=80 条，「加载更早消息」按 200 递增放开），桌面
//      messages.map 全量渲染。上千条会话时每次输入/滚动都会重算全部气泡的 markdown——
//      这才是长会话卡顿的根源。已把窗口化搬进 desktop MessageList + ChatPane。
//
//   2. 超大备份包 → **已覆盖**。导入走共享 readBackupText（分片 + 增量解码，
//      超过上限直接 rejected）；导出走共享 exportBackup。桌面没有另写读写路径。
//
//   3. 日志累积 → **已覆盖**。诊断日志有 MAX_ENTRIES=50 + 单字段 2000 字上限；
//      看屏幕线程 THREAD_MAX=50、单线程 THREAD_ENTRY_MAX=60；截图按 mtime 滚动清扫
//      保留 20 张。都是共享层常量，桌面没有绕过的写路径。
//
// 附带核对：会话切换器的列表全量渲染（手机同样），会话数量通常在几十量级，
// 不属于需要窗口化的热点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const LIST = read('src', 'provider', 'MessageList.jsx');
const PANE = read('src', 'provider', 'ChatPane.jsx');

test('超长会话：桌面列表按窗口渲染，且窗口常量来自共享层', () => {
  // 数据层裁剪（不是虚拟化）：只渲染尾部 N 条。
  assert.ok(LIST.includes('windowSize'), '列表应接受 windowSize');
  assert.ok(/messages\.slice\(total - windowSize\)/.test(LIST), '应按窗口裁尾部');
  assert.ok(/hiddenCount > 0/.test(LIST), '被裁掉时应有「加载更早」入口');
  assert.ok(LIST.includes('chat.list.loadEarlier'), '应复用手机词条');
  // 常量唯一来源在共享层（与手机同值，否则两端体验分叉）。
  const constants = readRoot('src', 'chat', 'chatConstants.js');
  assert.ok(/MESSAGE_WINDOW_INITIAL = 80/.test(constants), '共享层应有初始窗口常量');
  assert.ok(/MESSAGE_WINDOW_STEP = 200/.test(constants), '共享层应有步长常量');
  // 窗口状态与放开逻辑抽到 chat/useDesktopMessageWindow（ChatPane 已到 800 行）。
  // 断言改为「hook 用共享常量 + ChatPane 用 hook」，判据比原来更准。
  assert.ok(PANE.includes('useDesktopMessageWindow'), '聊天页应使用窗口化 hook');
  const hook = read('src', 'chat', 'useDesktopMessageWindow.js');
  assert.ok(hook.includes('MESSAGE_WINDOW_INITIAL'), 'hook 应使用共享初始窗口');
  assert.ok(hook.includes('MESSAGE_WINDOW_STEP'), 'hook 应使用共享步长');
  // 切会话必须重置窗口，否则上一个会话放开的窗口会带过来。
  assert.ok(/setWindowSize\(MESSAGE_WINDOW_INITIAL\)/.test(hook), '切会话应重置窗口');
  assert.ok(/\[sessionId\]/.test(hook), '重置应依赖会话 id');
});

test('超大备份：读写都走共享分片实现，桌面不另写路径', () => {
  const services = read('src', 'backup', 'services.js');
  assert.ok(services.includes('readBackupText'), '导入应走共享分片读');
  assert.ok(services.includes('exportBackup'), '导出应走共享实现');
  const shared = readRoot('src', 'storage', 'backupRead.js');
  assert.ok(/strategy: 'chunked'/.test(shared), '共享层应有分片策略');
  assert.ok(/reason: 'too-large'/.test(shared), '超上限应拒绝而不是 OOM');
});

test('日志累积：诊断日志与屏幕线程都有硬上限', () => {
  const diag = readRoot('src', 'storage', 'diagnostics.js');
  assert.ok(/MAX_ENTRIES = 50/.test(diag), '诊断日志应有条数上限');
  assert.ok(/MAX_FIELD_CHARS = 2000/.test(diag), '单字段应有长度上限');
  // 写入与读取两条路径都要裁剪（只裁一条会让旧数据继续膨胀）。
  assert.ok(/slice\(-MAX_ENTRIES\)/.test(diag), '写入/读取应裁到上限');

  const threads = readRoot('src', 'screenWatch', 'threads.js');
  assert.ok(/THREAD_MAX = 50/.test(threads), '屏幕线程应有条数上限');
  assert.ok(/THREAD_ENTRY_MAX = 60/.test(threads), '单线程条目应有上限');
});

test('截图累积：按 mtime 滚动清扫（桌面是自己的实现，必须守住）', () => {
  // 桌面截图在 electron/ipc/capture.js（主进程），清扫上限与手机同为 20 张。
  const capture = read('electron', 'ipc', 'capture.js');
  assert.ok(/SWEEP_KEEP = 20/.test(capture), '截图保留张数应与手机一致');
  assert.ok(/pickStaleCaptures/.test(capture), '缺清扫判据');
  // 按 mtime 而非文件名（同毫秒连拍时名字排序会误删刚拍的）。
  assert.ok(/mtimeMs/.test(capture), '清扫应按 mtime');
});