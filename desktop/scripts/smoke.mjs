// 冒烟启动器：在真实 Electron 运行时里跑 S1 全链路（见 electron/smoke-probe.js）。
//
// 用法（在 desktop/ 下）：npm run smoke
// 产物：<userData>/smoke.png（窗口截图）+ 标准输出一行 SMOKE_RESULT JSON。
// 退出码：探测全通过 0，否则 1。
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, EASYCHAT2_DESKTOP_SMOKE: '1' },
});
child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', error => {
  console.error('failed to launch electron:', error);
  process.exit(1);
});
