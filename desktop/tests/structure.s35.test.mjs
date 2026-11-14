// 桌面外壳结构守卫（S35）：压力探针与打包脚本的可用性。
//
// 这一轮的产出不是功能，而是**可复跑的验证手段**，所以守卫针对手段本身：
//
//   1. 压力探针必须存在，且按真实分键结构造数据。
//      第一版踩过两个坑，都写进断言：
//        · 写 @easychat2_characters（旧版整库键）→ 被判 corrupt 并备份；
//          真实结构是 @easychat2_character_item::<id> + _index{ids,revision}；
//        · 在同一轮里造完数据就量渲染 → 应用没重读，bubblesMounted 恒为 0。
//          必须 seed → reload → measure 两阶段。
//
//   2. 打包脚本必须在输出目录被占用时自动回退。
//      Windows 上 SearchIndexer/杀软会持有刚写出的 app.asar（不带 FILE_SHARE_DELETE），
//      electron-builder 因此报 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE。实测：
//      Restart Manager 查不到占用者、文件可读写但删不掉、等两分钟不释放。
//      把这种情况判成构建失败对用户没有意义——包是能打出来的。
//
//   3. 冒烟判据必须反映现状：S18 之后看屏幕已可用，原来「点看屏幕等屏幕捕获文案」
//      的断言从此必红，而当时的校验命令 grep 到的是嵌套字段 chat.sendResult.ok，
//      把顶层 ok:false 掩盖了 16 轮。这里钉住「不可用项仍可展开并显示原因」，
//      并改用当前真正不可用的入口（本地模型 / llama.rn）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const STRESS = read('electron', 'stress-probe.js');
const DIST = read('scripts', 'dist-desktop.mjs');
const MAIN = read('electron', 'main.js');
const SCREENS = read('electron', 'smoke-probe-screens.js');

test('压力探针：按真实分键结构造数据，不碰旧版整库键', () => {
  assert.ok(STRESS.includes('@easychat2_character_item::'), '角色应按分键写');
  assert.ok(STRESS.includes('@easychat2_character_index'), '应写 id 索引');
  assert.ok(/revision/.test(STRESS), '索引应带 revision（避免旧快照冲突）');
  assert.ok(STRESS.includes('@easychat2_messages::'), '消息应按会话分键');
  assert.ok(STRESS.includes('@easychat2_active_session'), '应设置活跃会话指针');
  // 旧版整库键绝不能出现（写不合规形状会被判 corrupt）。
  assert.ok(!/kv\.set\(\s*['"]@easychat2_characters['"]/.test(STRESS),
    '不得写 @easychat2_characters（旧版整库键）');
});

test('压力探针：两阶段（seed → reload → measure），且只在 measure 清理', () => {
  assert.ok(STRESS.includes('phase === \'measure\'') || /phase.*measure/.test(STRESS), '应有 measure 阶段');
  // seed 阶段不得清理（否则 measure 时数据已经没了）。
  const seedBody = STRESS.slice(STRESS.indexOf('async function seed'), STRESS.indexOf('async function measure'));
  assert.ok(!/kv\.remove\(`\$\{MESSAGES_PREFIX\}/.test(seedBody), 'seed 阶段不应删除消息');
  // measure 阶段必须清理。
  const measureBody = STRESS.slice(STRESS.indexOf('async function measure'));
  assert.ok(/kv\.remove\(`\$\{MESSAGES_PREFIX\}/.test(measureBody), 'measure 阶段应清理');
  assert.ok(measureBody.includes('cleanedUp'), '应记录清理结果');
  // 清理只按 stress- 前缀，绝不误删用户数据。
  assert.ok(STRESS.includes("const STRESS_PREFIX = 'stress-'"), '清理判据应是固定前缀');
  // 主进程确实做了 reload。
  assert.ok(/webContents\.reload\(\)/.test(MAIN), '主进程应 reload 后再 measure');
});

test('压力探针：真实量级与窗口化判据', () => {
  assert.ok(/STRESS_MESSAGE_COUNT = 1000/.test(STRESS), '会话应为 1000 条');
  assert.ok(/STRESS_CHARACTER_COUNT = 50/.test(STRESS), '角色应为 50 个');
  assert.ok(/BACKUP_BYTES = 100 \* 1024 \* 1024/.test(STRESS), '备份包应为 100MB');
  // 窗口化判据：挂载数应远少于总条数（共享 MESSAGE_WINDOW_INITIAL=80）。
  assert.ok(/bubblesWindowed/.test(STRESS), '应记录窗口化是否生效');
  assert.ok(/data-message-id/.test(STRESS), '应按真实气泡选择器计数');
  assert.ok(/loadEarlierSeen/.test(STRESS), '应确认「加载更早」入口可见');
});

test('打包脚本：输出目录被占用时自动回退，并报告真实路径', () => {
  assert.ok(DIST.includes('ERR_ELECTRON_BUILDER_CANNOT_EXECUTE'), '应识别已知占用错误');
  assert.ok(DIST.includes('directories.output='), '回退时应改输出目录');
  assert.ok(/release-\$\{stamp\}|release-\$/.test(DIST) || DIST.includes("`release-${stamp}`"),
    '回退目录应带时间戳（不覆盖已有产物）');
  assert.ok(DIST.includes('[dist] ok'), '应打印最终产物路径');
  // package.json 的 dist 脚本必须指向这个包装器（否则等于没接）。
  const pkg = read('package.json');
  assert.ok(/\"dist\":\s*\"node scripts\/dist-desktop\.mjs\"/.test(pkg), 'dist 脚本应指向包装器');
});

test('冒烟判据与实际能力状态一致（不可用项仍能展开看原因）', () => {
  // S18 之后看屏幕已可用，探针不能再找它当「不可用项」。
  assert.ok(!/includes\('看屏幕'\)/.test(SCREENS), '不应再用看屏幕作为不可用入口');
  assert.ok(SCREENS.includes('本地模型') || SCREENS.includes('Local models'),
    '应改用当前仍不可用的入口');
  assert.ok(SCREENS.includes('llama.rn'), '原因文案判据应是稳定 ASCII 片段');
});
