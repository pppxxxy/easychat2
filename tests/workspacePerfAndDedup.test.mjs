// FEAT-AC12：大树工作区卡顿三连修。
//
// 来源：用户 20:49–21:01 真机卡顿现场 + 截图 #461/#462 + 诊断日志。对码基线 HEAD=8698891。
// 触发背景：工作区里刚克隆了 easychat2 仓库（数千文件的 RN 项目）。
//
// 三个根因（全部对码核实）：
//   BUG-A【P0 卡顿】目录遍历逐条目串行（每个文件一次 getInfo、每个目录一次
//     readDirectoryAsync，上限 MAX_FILES=2000）⇒ 克隆后每次进文件/GitHub 面板
//     都跑满数千次跨进程 IO。
//   BUG-B【P0 重复发送】`if (sending)` 守卫读的是 React state，而 setState 异步批处理
//     ⇒ 连点/JS 忙时后续点击全部穿透 ⇒ 截图 #462 三条一模一样的「帮我拉取」。
//     日志佐证：同时段零 turn-start（消息落了库，回合一个都没启动）。
//   BUG-C【P0 UX】回合小结卡片只有「收起/撤销」两个出口，没有关闭；且 `.shell-cwd`
//     每条命令都被重写 ⇒ 每轮都有提交 ⇒ 卡片永远有货、永远挡视野。
//
// 测试分工（仓库纪律）：纯逻辑真跑；组件层靠源码契约断言
//（本仓无 react-test-renderer 依赖，见 P0-2 组的说明）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SEND_DECISIONS,
  SEND_DEDUP_WINDOW_MS,
  createSendGate,
  normalizeSendText,
} from '../src/workspace/sendGuard.js';
import {
  createWorkspaceListCache,
  createListCachingStore,
  listCacheKey,
  workspaceListCache,
} from '../src/workspace/listCache.js';
import {
  GIT_IGNORED_WORKSPACE_FILES,
  isGitIgnoredWorkspacePath,
  isProtectedWorkspacePath,
} from '../src/workspace/paths.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------- ① P0-1：清单缓存（纯逻辑真跑）----------

test('P0-1 缓存：命中即 0 次 IO（同一个键只跑一次 loader）', async () => {
  const cache = createWorkspaceListCache();
  let loads = 0;
  const key = listCacheKey({ root: 'r', characterId: 'c', subdir: '', match: '' });
  const loader = async () => { loads += 1; return { files: ['a.txt'], truncated: false }; };

  const first = await cache.withCache(key, loader);
  const second = await cache.withCache(key, loader);
  assert.equal(loads, 1, '第二次必须命中缓存（0 次 IO）——这正是卡顿的解药');
  assert.deepEqual(first, second);
  assert.equal(cache.size(), 1);
});

test('P0-1 缓存：**并发合并**——同一键的两个同时读取只跑一次 loader', async () => {
  // 真实形态：面板挂载 + 用户点刷新同时发生。
  const cache = createWorkspaceListCache();
  let loads = 0;
  const key = listCacheKey({ root: 'r', characterId: 'c' });
  const loader = () => new Promise(resolve => {
    loads += 1;
    setTimeout(() => resolve({ files: ['x'], truncated: false }), 5);
  });
  const [a, b, c] = await Promise.all([
    cache.withCache(key, loader),
    cache.withCache(key, loader),
    cache.withCache(key, loader),
  ]);
  assert.equal(loads, 1, '三个并发只该跑一次（否则「挂载+刷新」会叠出三次全树遍历）');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('P0-1 缓存：**写后失效**（不能给出过期清单——那比慢更糟）', async () => {
  const cache = createWorkspaceListCache();
  const store = {
    listWorkspaceFilesWithMeta: async () => ({ files: ['before.txt'], truncated: false }),
    writeWorkspaceFile: async () => ({ path: 'new.txt', length: 1 }),
    readWorkspaceFile: async () => ({ content: 'x' }),
  };
  const cached = createListCachingStore(store, { rootKey: 'r', cache });
  await cached.listWorkspaceFilesWithMeta({ characterId: 'c1' });
  assert.equal(cache.size(), 1);

  store.listWorkspaceFilesWithMeta = async () => ({ files: ['after.txt'], truncated: false });
  await cached.writeWorkspaceFile({ characterId: 'c1', path: 'new.txt', content: 'x' });
  const after = await cached.listWorkspaceFilesWithMeta({ characterId: 'c1' });
  assert.deepEqual(after.files, ['after.txt'],
    '写之后必须重算（缓存给出过期清单 = 用户以为刚建的文件不存在）');
});

test('P0-1 缓存：失效按**角色**精确匹配（不能误伤前缀相同的角色）', () => {
  const cache = createWorkspaceListCache();
  cache.set(listCacheKey({ root: 'r', characterId: 'a' }), { files: ['a'], truncated: false });
  cache.set(listCacheKey({ root: 'r', characterId: 'ab' }), { files: ['ab'], truncated: false });
  cache.invalidate('a');
  assert.equal(cache.get(listCacheKey({ root: 'r', characterId: 'a' })), null, 'a 的键要清掉');
  assert.ok(cache.get(listCacheKey({ root: 'r', characterId: 'ab' })), 'ab 的键不得被误清');
});

test('P0-1 缓存：键区分 root / subdir / match（换根不能命中旧缓存）', () => {
  const base = { characterId: 'c', subdir: '', match: '' };
  const keys = [
    listCacheKey({ ...base, root: 'rootA' }),
    listCacheKey({ ...base, root: 'rootB' }),
    listCacheKey({ ...base, root: 'rootA', subdir: 'src/' }),
    listCacheKey({ ...base, root: 'rootA', match: 'readme' }),
  ];
  assert.equal(new Set(keys).size, 4, '四个维度任一不同都必须是不同的键');
});

test('P0-1 缓存：loader 抛错**不留半个缓存**（下次仍会真的重试）', async () => {
  const cache = createWorkspaceListCache();
  const key = listCacheKey({ root: 'r', characterId: 'c' });
  await assert.rejects(() => cache.withCache(key, async () => { throw new Error('boom'); }));
  assert.equal(cache.size(), 0, '失败不得写入缓存（否则一次瞬时失败会被永久记住）');
  // 重试要真的再跑一次
  let second = false;
  const ok = await cache.withCache(key, async () => { second = true; return { files: [], truncated: false }; });
  assert.equal(second, true, '失败之后必须真的重试');
  assert.deepEqual(ok.files, []);
});

test('P0-1 缓存：批处理只打脏一次（导入 600 文件 ≠ 600 次失效）', async () => {
  const cache = createWorkspaceListCache();
  let invalidations = 0;
  const spy = {
    ...cache,
    invalidate: characterId => { invalidations += 1; cache.invalidate(characterId); },
  };
  const store = {
    listWorkspaceFilesWithMeta: async () => ({ files: [], truncated: false }),
    writeWorkspaceFile: async () => ({ path: 'f', length: 1 }),
    beginBatch: () => {}, endBatch: () => null, abortBatch: () => {},
  };
  const cached = createListCachingStore(store, { rootKey: 'r', cache: spy });
  cached.beginBatch('c1', {});
  for (let i = 0; i < 5; i += 1) await cached.writeWorkspaceFile({ characterId: 'c1', path: `f${i}`, content: 'x' });
  assert.equal(invalidations, 0, '批内不该逐次失效');
  cached.endBatch();
  assert.equal(invalidations, 1, '批结束打脏一次');
});

test('P0-1 缓存：abortBatch 也要打脏（批中途写进去的文件同样改变清单）', () => {
  const cache = createWorkspaceListCache();
  let invalidated = 0;
  const spy = { ...cache, invalidate: id => { invalidated += 1; cache.invalidate(id); } };
  const store = {
    listWorkspaceFilesWithMeta: async () => ({ files: [], truncated: false }),
    writeWorkspaceFile: async () => ({ path: 'f', length: 1 }),
    beginBatch: () => {}, endBatch: () => null, abortBatch: () => {},
  };
  const cached = createListCachingStore(store, { rootKey: 'r', cache: spy });
  cached.beginBatch('c1', {});
  cached.abortBatch();
  assert.equal(invalidated, 1, '取消批次也必须打脏');
});

test('P0-1 接线：native.js 把缓存装饰器装在 store 外层（且带 rootKey）', () => {
  const native = stripComments(read('src/workspace/native.js'));
  assert.match(native, /createListCachingStore\(/, '必须装上清单缓存装饰器');
  assert.match(native, /rootKey:/, '必须给 rootKey（换根不能命中旧缓存——那会显示另一个文件夹）');
  // 缓存必须在 history 装饰器**外层**：一次写只打脏一次
  assert.match(native, /createListCachingStore\(recorded/,
    '缓存包在 history 记录器外面（两层各管各的批状态）');
  // 后端本身**不改**（缓存是与后端无关的横切关注点）
  const store = read('src/workspace/store.js');
  assert.equal(/listCache|cache\.withCache/.test(stripComments(store)), false,
    '后端不应内联缓存逻辑（两个后端共用装饰器，避免各写一份失效逻辑而漂移）');
});

// ---------- ② P0-2：发送闸门（纯逻辑真跑）----------

test('P0-2 闸门：in-flight 期间第二次 begin 返回 IN_FLIGHT（同步，不依赖 React）', () => {
  const gate = createSendGate();
  assert.equal(gate.begin('你好'), SEND_DECISIONS.OK);
  assert.equal(gate.isInFlight(), true);
  assert.equal(gate.begin('你好'), SEND_DECISIONS.IN_FLIGHT, '第二次必须被挡（这正是旧守卫漏掉的窗口）');
  assert.equal(gate.begin('完全不同的内容'), SEND_DECISIONS.IN_FLIGHT, '内容不同也挡（锁是回合级的）');
  gate.end();
  assert.equal(gate.isInFlight(), false);
});

test('P0-2 闸门：**连点 10 次只放行 1 次**（截图 #462 的正面回归）', () => {
  // 精确复刻事故形态：同一个动作在极短时间里被点多次。
  const gate = createSendGate();
  const results = [];
  for (let i = 0; i < 10; i += 1) results.push(gate.begin('帮我拉取easychat2'));
  assert.equal(results.filter(r => r === SEND_DECISIONS.OK).length, 1,
    '连点 10 次只能放行 1 次（旧守卫在这里全部穿透 ⇒ 三条重复消息）');
  assert.equal(results.filter(r => r === SEND_DECISIONS.IN_FLIGHT).length, 9);
});

test('P0-2 闸门：3 秒内相同文本判 DUPLICATE，窗口外放行', () => {
  const gate = createSendGate();
  const t0 = 1_000_000;
  assert.equal(gate.begin('拉取仓库', t0), SEND_DECISIONS.OK);
  gate.end(); // 回合结束（模拟快速失败/极短回合）
  // 窗口内重复 → 丢弃
  assert.equal(gate.begin('拉取仓库', t0 + 1000), SEND_DECISIONS.DUPLICATE);
  assert.equal(gate.begin('拉取仓库', t0 + SEND_DEDUP_WINDOW_MS - 1), SEND_DECISIONS.DUPLICATE);
  // 窗口外 → 放行（用户确实想再发一次）
  assert.equal(gate.begin('拉取仓库', t0 + SEND_DEDUP_WINDOW_MS), SEND_DECISIONS.OK);
});

test('P0-2 闸门：不同文本不受去重影响；被丢弃的发送**不刷新时间窗**', () => {
  const gate = createSendGate();
  const t0 = 2_000_000;
  // ① 不同文本照常放行
  assert.equal(gate.begin('第一条', t0), SEND_DECISIONS.OK);
  gate.end();
  assert.equal(gate.begin('第二条', t0 + 100), SEND_DECISIONS.OK, '不同文本照常放行');
  gate.end();
  assert.equal(gate.begin('第三条', t0 + 200), SEND_DECISIONS.OK);
  gate.end();

  // ② 「被丢弃不刷新窗口」：以第三条为基准，在**原窗口内**连发多次，
  //    若丢弃会刷新窗口，最后一次就会变成 OK（那会让用户正常重试被无限判重复）。
  //    时间点都 < t0+200+WINDOW，所以每一次都必须是 DUPLICATE。
  assert.equal(gate.begin('第三条', t0 + 200 + 10), SEND_DECISIONS.DUPLICATE);
  assert.equal(gate.begin('第三条', t0 + 200 + 20), SEND_DECISIONS.DUPLICATE,
    '被丢弃的发送不得刷新时间窗（否则连点会把窗口无限推后）');
  assert.equal(gate.begin('第三条', t0 + 200 + 30), SEND_DECISIONS.DUPLICATE);
  // 窗口一过就放行（用户确实想再发一次）
  assert.equal(gate.begin('第三条', t0 + 200 + SEND_DEDUP_WINDOW_MS), SEND_DECISIONS.OK);
});

test('P0-2 闸门：指纹折叠空白（卡顿时多点一个空格不该算新消息）', () => {
  assert.equal(normalizeSendText('  拉取  仓库  '), '拉取 仓库');
  assert.equal(normalizeSendText('拉取\t仓库'), '拉取 仓库');
  assert.equal(normalizeSendText('拉取\u3000仓库'), '拉取 仓库', '全角空格也要折叠');
  assert.equal(normalizeSendText(null), '');
  const gate = createSendGate();
  const t0 = 3_000_000;
  assert.equal(gate.begin('拉取仓库', t0), SEND_DECISIONS.OK);
  gate.end();
  assert.equal(gate.begin('拉取仓库 ', t0 + 10), SEND_DECISIONS.DUPLICATE, '尾随空格视为同一条');
});

test('P0-2 闸门：空文本不参与去重（不擅自放行也不误判）', () => {
  const gate = createSendGate();
  const t0 = 4_000_000;
  assert.equal(gate.begin('', t0), SEND_DECISIONS.OK);
  gate.end();
  // 空文本不被记住 ⇒ 不会被判重复（空发送在调用方就被挡掉了）
  assert.equal(gate.begin('', t0 + 10), SEND_DECISIONS.OK);
});

test('P0-2 接线：ChatPanel 用 ref 闸门，且**每条路径都释放**', () => {
  const chat = stripComments(read('src/workspace/screen/ChatPanel.js'));
  // 闸门实例放 ref（不是 state——state 正是本轮修的病）
  assert.match(chat, /sendGateRef = useRef\(null\)/, '闸门必须是 ref（同步翻位）');
  assert.match(chat, /createSendGate\(\)/, '要真的创建闸门实例');
  // 必须在**第一个 await 之前**判定（否则连点仍能穿透）
  const gateAt = chat.indexOf('gate.begin(text)');
  const sendAt = chat.indexOf('const handleSend = useCallback');
  assert.ok(gateAt > sendAt, '闸门判定要在 handleSend 里');
  // 释放点：定义一处 + 调用一处（用 `releaseGate` 计数，不写 `releaseGate()`
  // ——定义那行是 `releaseGate = () =>`，带括号的写法数不到它，我第一版就这么数错了）
  assert.match(chat, /const releaseGate = \(\) =>/, '要有释放函数定义');
  const releaseCalls = [...chat.matchAll(/releaseGate/g)].length;
  assert.ok(releaseCalls >= 2, `定义 + 调用（实际 ${releaseCalls} 处）`);
  assert.match(chat, /releaseGate\(\);/, '必须有真正的释放调用');
  // ⚠️ 关键：IN_FLIGHT 分支**绝不能**调 gate.end()——那会放掉真正持有者的锁。
  // 只取到该分支的**行尾**为止（`return;`），不能开固定宽度窗口：
  // 窗口取宽了会划进紧随其后的 releaseGate 定义（里面有 gate.end()），
  // 于是断言把「定义」当成「违规」——我第一版正是这么误报的。
  const inFlightAt = chat.indexOf('if (decision !== SEND_DECISIONS.OK)');
  assert.ok(inFlightAt > 0, '要有 IN_FLIGHT 兜底分支');
  const branchEnd = chat.indexOf('\n', inFlightAt);
  const branch = chat.slice(inFlightAt, branchEnd);
  assert.equal(/gate\.end\(\)/.test(branch), false,
    `IN_FLIGHT 时我们没拿到锁，end() 会放掉持有者的锁 ⇒ 闸门在一轮运行期间敞开: ${branch}`);
  assert.match(branch, /return;/, '该分支应直接返回（不碰锁）');
});

test('P0-2 接线：闸门**拿到之后**抛错也必须放锁（否则发送按钮永久失效）', () => {
  // 本轮自查发现并修掉的一个真缺陷：闸门在装配段之前就拿到了，而内层 try 在装配
  // **之后**才开。于是「注册工具/读记忆/拼提示词」抛错时 finally 不执行 ⇒ 闸门永锁
  // ⇒ 用户之后再也发不出消息（比重复消息严重得多）。
  // 判据：释放点必须覆盖装配段——即 gate.begin 之后存在**两层**保护
  //（内层 try/finally + 外层 catch 兜底），且都在 releaseGate。
  const chat = stripComments(read('src/workspace/screen/ChatPanel.js'));
  const beginAt = chat.indexOf('gate.begin(text)');
  assert.ok(beginAt > 0, '前提：有闸门获取');
  const after = chat.slice(beginAt);
  const releaseCalls = [...after.matchAll(/releaseGate\(\)/g)].length;
  assert.ok(releaseCalls >= 2,
    `gate.begin 之后至少要两处释放（内层 finally + 装配段兜底），实际 ${releaseCalls}`);
  // 兜底那处必须在 catch 里（而不是只靠 finally）
  assert.match(after, /\}\s*catch \(error\) \{[\s\S]{0,400}?releaseGate\(\)/,
    '装配段抛错时必须在 catch 里放锁（finally 覆盖不到它）');
});

test('P0-2 接线：重复发送**明确提示**（不静默丢弃）', () => {
  const chat = stripComments(read('src/workspace/screen/ChatPanel.js'));
  assert.match(chat, /SEND_DECISIONS\.DUPLICATE[\s\S]{0,300}?Alert\.alert\(/,
    '重复发送必须弹提示——静默会让用户以为「点了没反应」');
  for (const locale of ['zh-CN', 'en']) {
    // FEAT-AC12：workspace.chat.* 整域已抽到 workspaceChat.js（workspace.js 贴 800 行上限）。
    // 两个文件都查：词条搬到哪都不该漏（只查一处会在搬家时静默失败）。
    const dict = read(`src/i18n/locales/${locale}/workspaceChat.js`)
      + read(`src/i18n/locales/${locale}/workspace.js`);
    assert.ok(dict.includes("'workspace.chat.duplicate.title'"), `${locale} 缺 duplicate.title`);
    assert.ok(dict.includes("'workspace.chat.duplicate.body'"), `${locale} 缺 duplicate.body`);
  }
});

// ---------- ③ P0-3：`.shell-cwd` 不入提交 + 小结卡关闭出口 ----------

test('P0-3：`.shell-cwd` 被排除在提交之外（否则每轮都多一条无信息量的提交）', () => {
  assert.ok(GIT_IGNORED_WORKSPACE_FILES.includes('.easychat/.shell-cwd'),
    '.shell-cwd 必须在「不入提交」清单里');
  assert.equal(isGitIgnoredWorkspacePath('.easychat/.shell-cwd'), true);
  assert.equal(isGitIgnoredWorkspacePath('.easychat/.shell-cwd '), true, '首尾空白要归一');
  assert.equal(isGitIgnoredWorkspacePath('./.easychat/.shell-cwd'), true, './ 前缀要归一');
  assert.equal(isGitIgnoredWorkspacePath('src/a.js'), false, '普通文件不受影响');
  assert.equal(isGitIgnoredWorkspacePath(''), false);
  // ⚠️ 与「写保护」不是一回事：agent 仍可写它（它是 shell 会话的正常状态文件）
  assert.equal(isProtectedWorkspacePath('.easychat/.shell-cwd'), false,
    '.shell-cwd 不该进写保护清单（那会让 shell 会话记忆直接坏掉）');
});

test('P0-3：git 的 changedFiles 是**唯一**过滤点（四条路径同时正确）', () => {
  const git = stripComments(read('src/workspace/git.js'));
  assert.match(git, /changedFiles\(\)[\s\S]{0,400}?isGitIgnoredWorkspacePath\(row\.path\)/,
    '过滤必须收口在 changedFiles（status/discard/commitAll/UI 共用这一个入口）');
  // status()（全量）不得被过滤——它是「含 unmodified」的原始口径，UI 徽标等按需自己筛
  const statusBlock = git.slice(git.indexOf('async status()'), git.indexOf('async changedFiles()'));
  assert.equal(/isGitIgnoredWorkspacePath/.test(statusBlock), false,
    'status() 是全量原始口径，不该在这里过滤');
});

test('P0-3：小结卡有**第三个出口 ×**，且与展开按钮平级（不是嵌进去）', () => {
  const panel = stripComments(read('src/workspace/screen/TurnSummaryPanel.js'));
  // 关闭态：dismissed 判定存在，且真的返回 null（不是只置个标记）
  assert.match(panel, /if \(dismissed\) return null/, '关闭后必须不渲染');
  assert.match(panel, /setDismissedFor\(fingerprint\)/, '× 要记录被关闭的那份指纹');
  // ⚠️ × 必须与 header 平级：嵌进 header 的 TouchableOpacity 会被父级吃掉点击
  assert.match(panel, /styles\.headerRow[\s\S]{0,900}?styles\.dismiss/,
    '× 要与展开按钮同级（嵌进去会让点 × 变成展开/收起）');
  const headerRowBlock = panel.slice(panel.indexOf('styles.headerRow'));
  assert.ok(headerRowBlock.length > 0, '要有 headerRow 容器样式');
  // 无障碍标签
  assert.match(panel, /accessibilityLabel=\{t\('workspace\.chat\.summary\.dismiss'\)\}/,
    '× 要有可读的无障碍标签');
  for (const locale of ['zh-CN', 'en']) {
    const dict = read(`src/i18n/locales/${locale}/workspaceChat.js`)
      + read(`src/i18n/locales/${locale}/workspace.js`);
    assert.ok(dict.includes("'workspace.chat.summary.dismiss'"), `${locale} 缺 dismiss 词条`);
  }
});

test('P0-3：关闭是**会话内存态**，且数据变了会重新出现（不永久消失）', () => {
  const panel = stripComments(read('src/workspace/screen/TurnSummaryPanel.js'));
  // 不落盘：状态只在 useState 里（重启后回到显示态——那张卡是有用信息）
  assert.equal(/setWorkspaceSettings\([\s\S]{0,80}?dismiss/.test(panel), false,
    '关闭态不得落盘（用户只是这一轮不想看）');
  // 指纹随数据源 + 清单变化 ⇒ 新一轮内容不同时自动重现
  assert.match(panel, /dismissedFor !== '' && dismissedFor === fingerprint/,
    '必须按指纹判定（数据变了就重新出现）');
  assert.match(panel, /`\$\{fromCommit \? 'commit' : 'trace'\}/,
    '指纹要含数据源（commit ⇄ trace 切换算不同内容）');
  // 收起/撤销两个既有出口不得被本轮改动破坏
  assert.match(panel, /setCollapsed\(/, '收起仍在');
  assert.match(panel, /const undo = useCallback/, '撤销仍在');
});

// ---------- ④ 行数棘轮 ----------

test('行数：本轮新增/修改文件都在 800 硬上限内', () => {
  const count = source => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  for (const file of [
    'src/workspace/listCache.js',
    'src/workspace/sendGuard.js',
    'src/workspace/native.js',
    'src/workspace/git.js',
    'src/workspace/paths.js',
    'src/workspace/screen/TurnSummaryPanel.js',
  ]) {
    const lines = count(read(file));
    assert.ok(lines <= 800, `${file}: ${lines} > 800（棘轮纪律：拆文件，不抬上限）`);
  }
  // ChatPanel 仍在基线内（本轮改的是它，但不得越线）
  const baseline = JSON.parse(read('architecture-baseline.json')).fileLineBaseline;
  const limit = baseline['src/workspace/screen/ChatPanel.js'];
  const lines = count(read('src/workspace/screen/ChatPanel.js'));
  assert.ok(lines <= limit, `ChatPanel ${lines} > 基线 ${limit}（本轮新增靠外提腾空间）`);
});

// ---------- ⑤ 全局状态隔离 ----------

test('缓存单例：测试之间必须能重置（模块级状态不外泄）', () => {
  workspaceListCache.set('k', { files: [], truncated: false });
  assert.equal(workspaceListCache.size(), 1);
  workspaceListCache.__reset();
  assert.equal(workspaceListCache.size(), 0);
});
