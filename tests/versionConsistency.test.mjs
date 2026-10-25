// 版本号一致性：发版时最容易漏改的四处。
//
// 为什么需要这条：2026-10-23 把版本从 1.0.0 升到 1.0.1 时，改了 package.json / app.json /
// package-lock.json / CHANGELOG，**唯独漏了 README 顶部的「当前版本」横幅**，用户看仓库
// 首页还以为没更新。这类疏漏没有测试盯着就会反复发生，而成本极低。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('版本号一致：package.json / app.json / README 三处必须相同', () => {
  const pkgVersion = JSON.parse(read('package.json')).version;
  const expoVersion = JSON.parse(read('app.json')).expo.version;
  assert.equal(expoVersion, pkgVersion, 'app.json 的 expo.version 必须与 package.json 一致');

  // README 的版本横幅：`**当前版本：v1.0.1（测试版）**`
  const readme = read('README.md');
  const banner = readme.match(/\*\*当前版本：v?([\d.]+)/);
  assert.ok(banner, 'README 顶部必须有「当前版本」横幅');
  assert.equal(banner[1], pkgVersion, `README 版本横幅（${banner[1]}）必须与 package.json（${pkgVersion}）一致`);

  // 横幅下面那句说明也带版本号，一并钉住（漏改会出现「新版号 + 旧说明」的错位）。
  const bodyVersions = [...readme.matchAll(/^v([\d.]+) 为测试版/mg)].map(m => m[1]);
  assert.deepEqual(bodyVersions, [pkgVersion], '说明段落的版本号也必须一致');
});

test('版本号一致：CHANGELOG 必须有为当前版本开的条目', () => {
  const pkgVersion = JSON.parse(read('package.json')).version;
  const changelog = read('CHANGELOG.md');
  // 形如 `## [1.0.1] - 2026-10-23`
  const entry = new RegExp(`^## \\[${pkgVersion.replace(/\./g, '\\.')}\\]`, 'm');
  assert.match(
    changelog,
    entry,
    `CHANGELOG 缺少 [${pkgVersion}] 条目——发版了却没写改了什么`
  );
  // [Unreleased] 是**合法**的：它记录「已发布版本的增量」，等下次发版才结算成具体版本号。
  // 真正要防的是反过来的错位——CHANGELOG 里出现了比 package.json 更新的已发布条目，
  // 说明发了版却没升 package.json。
  const published = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1]);
  const newer = published.filter(version => version !== pkgVersion && compare(version, pkgVersion) > 0);
  assert.deepEqual(
    newer,
    [],
    `CHANGELOG 里有比 package.json（${pkgVersion}）更新的条目：${newer.join(', ')}`
  );
});

// 极简版本比较（只用于本文件断言，不依赖被测产品实现，避免循环验证）。
function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

test('版本号一致：versionCode 为正整数，且不沿用已发布的旧值', () => {
  const android = JSON.parse(read('app.json')).expo.android;
  const code = android.versionCode;
  assert.ok(Number.isInteger(code) && code > 0, 'versionCode 必须是正整数');
  // Android 要求新包的 versionCode 严格大于已安装的；1.0.0 发布时用的是 2。
  assert.ok(code > 2, `versionCode 必须大于历史值 2（当前 ${code}），否则覆盖安装会被系统拒绝`);
});
