// Kilo 匿名网关实时冒烟：走真实网络，验证「匿名配置 -> 不发鉴权头 -> 真实回复落盘」。
//
// 与 npm run smoke 的区别：不启动本地 mock 模型，配置就是 Kilo 匿名 FREE 路由，
// 判据只有一条——界面上发出一条消息并收到真实模型回复。
// 免费池按 IP 限流（200 次/小时）且个别 :free 模型会临时下线，失败时先看真实原因。
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, EASYCHAT2_DESKTOP_SMOKE: '1', EASYCHAT2_KILO_LIVE: '1' },
});
child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', error => {
  console.error('failed to launch electron:', error);
  process.exit(1);
});
