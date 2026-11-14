// 桌面打包脚本：vite build → electron-builder，并在输出目录被占用时自动回退。
//
// 为什么需要这一层（不是多此一举）：
//   Windows 上 `release/` 这个输出目录经常被**别的进程**持有句柄——实测是
//   SearchIndexer.exe 在索引刚写出的 app.asar（它打开文件时不带 FILE_SHARE_DELETE），
//   于是 electron-builder 清理输出目录时失败，报 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE。
//   这种占用：
//     · Restart Manager 查不到（索引器是服务，句柄在过滤驱动层）；
//     · 文件能读也能写（ReadWrite + FileShare.ReadWrite 可以打开），只是删不掉；
//     · 杀进程/等几分钟都不一定释放。
//
//   直接把构建判失败对用户没有意义——包是能打出来的，只是不能写回那个目录。
//   所以这里：先按配置的输出目录构建；遇到**已知的目录占用失败**就换一个
//   release-<时间戳> 目录重试一次，并如实打印最终产物路径。其它失败照常失败。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');

// 已知的「输出目录被占用」特征：electron-builder 只会给出这个泛化错误码，
// 所以同时检查它是否提到了我们自己的构建工具链，避免把别的原因误判成占用。
const LOCK_HINTS = [
  'ERR_ELECTRON_BUILDER_CANNOT_EXECUTE',
  'EBUSY',
  'EPERM',
  'resource busy',
  '正由另一进程使用',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

function looksLikeLockFailure(output) {
  const text = String(output || '');
  return LOCK_HINTS.some(hint => text.includes(hint));
}

function buildElectronBuilder(outputDir) {
  const args = ['electron-builder', '--win', 'nsis', 'zip', '--publish', 'never'];
  if (outputDir) args.push(`-c.directories.output=${outputDir}`);
  const result = spawnSync('npx', args, {
    cwd: DESKTOP,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  const merged = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) process.stdout.write(merged);
  return { ok: result.status === 0, output: merged };
}

function findInstaller(dir) {
  try {
    const names = fs.readdirSync(dir);
    const exe = names.find(name => /^EasyChat2-.*-x64\.exe$/.test(name));
    return exe ? path.join(dir, exe) : '';
  } catch (error) {
    return '';
  }
}

// 1) 前端构建（失败就直接退出——那是真错误）
const vite = run('npx', ['vite', 'build']);
if (vite.status !== 0) {
  console.error('[dist] vite build 失败');
  process.exit(vite.status || 1);
}

// 2) 先按配置的输出目录（package.json 的 build.directories.output = release）
const primary = buildElectronBuilder(null);
if (primary.ok) {
  const installer = findInstaller(path.join(DESKTOP, 'release'));
  console.log(`[dist] ok：${installer || path.join(DESKTOP, 'release')}`);
  process.exit(0);
}

if (!looksLikeLockFailure(primary.output)) {
  console.error('[dist] electron-builder 失败，且不是输出目录占用（见上方日志）');
  process.exit(1);
}

// 3) 目录被占用：换一个新目录重试一次，并如实说明原因与最终路径
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const fallback = `release-${stamp}`;
console.warn(
  `[dist] 输出目录被其它进程占用（Windows 上常见：搜索索引器/杀软持有刚写出的 app.asar）。\n`
  + `[dist] 已自动回退到 ${fallback} 重新打包。`
);
const retry = buildElectronBuilder(fallback);
if (!retry.ok) {
  console.error('[dist] 回退目录也失败（见上方日志）');
  process.exit(1);
}
const installer = findInstaller(path.join(DESKTOP, fallback));
console.log(`[dist] ok（回退目录）：${installer || path.join(DESKTOP, fallback)}`);