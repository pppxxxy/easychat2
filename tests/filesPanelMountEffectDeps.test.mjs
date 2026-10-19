// 文件面板挂载 effect 的**依赖数组守卫**。
//
// 为什么单独一条，而且用源码断言而不是真渲染：
//   tests/filesPanelDrilldown.test.mjs 用真渲染证明了「点一次就能进」这个行为。
//   但如果有人把 refresh 重新放回依赖数组（即把这个 bug 改回来），真渲染测试不会
//   **失败**，而是**挂死**——因为 effect 会陷入
//   「重跑 → setCharacterId → refresh 换引用 → 再重跑」的同步循环，
//   连 Promise.race 的超时都救不了（循环不让出事件循环，定时器永远不触发）。
//   实测：注入该 bug 后 120 秒仍未退出，只能 kill。
//
//   一个「挂死」的测试在 CI 上是整包超时，定位成本极高；而这条源码断言会**立即**
//   以一条清晰的失败信息指出问题。两者互补：
//   行为测试保证「现在是对的」，本守卫保证「改回错的会立刻被抓住」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(path.resolve('src/workspace/screen/FilesPanel.js'), 'utf8');

// 剥掉注释再判——解释这个 bug 的注释里会原样出现 `[visible, refresh, t, refreshAppData]`，
// 不剥的话守卫会误报（本轮就真的踩到过同型问题）。
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 取出挂载 effect 的依赖数组（它是文件里唯一以 `}, [visible` 结尾的那处）。
function mountEffectDeps(code) {
  const match = /\}\s*,\s*\[([^\]]*)\]\s*\)\s*;/.exec(
    // 从 `if (!visible) return;` 往后找最近的依赖数组，避免误匹配别的 effect
    code.slice(code.indexOf('if (!visible) return;'))
  );
  return match ? match[1].split(',').map(item => item.trim()).filter(Boolean) : null;
}

test('挂载 effect 的依赖数组必须只含 visible（含 refresh 会无限重跑）', () => {
  const deps = mountEffectDeps(stripComments(SOURCE));
  assert.ok(deps, '找不到挂载 effect 的依赖数组');
  assert.deepEqual(
    deps,
    ['visible'],
    `挂载 effect 的语义是「面板打开时初始化一次」，依赖只能是 visible。`
    + `实际：[${deps.join(', ')}]。`
    + ' 含 refresh 时：subdir 一变 refresh 换引用 → effect 重跑 → setFiles([]) → '
    + '退空保护把用户踢回根层（用户报告的「点一次进不去、要点两次」）。'
  );
});

test('挂载 effect 内部必须通过 refreshRef 调用最新 refresh（不能直接调 refresh）', () => {
  const code = stripComments(SOURCE);
  const effectStart = code.indexOf('if (!visible) return;');
  const effectEnd = code.indexOf('refreshAppData().catch', effectStart);
  assert.ok(effectStart > 0 && effectEnd > effectStart, '定位不到挂载 effect 主体');
  const body = code.slice(effectStart, effectEnd + 200);

  assert.ok(
    /refreshRef\.current\(/.test(body),
    '挂载 effect 必须通过 refreshRef.current(...) 调用 refresh —— '
    + '直接调 refresh 会读旧闭包（或被迫把 refresh 放进依赖，从而复发本 bug）'
  );
  assert.equal(
    /(^|[^.\w])refresh\(resolved\.id/.test(body),
    false,
    '不得在挂载 effect 里直接调用 refresh(resolved.id...)：那是依赖污染的另一面'
  );
  // refreshRef 必须在 effect 之外维护，否则依赖还是绕不过去。
  assert.ok(
    /const refreshRef = useRef\(refresh\);/.test(code) && /refreshRef\.current = refresh;/.test(code),
    '必须有 refreshRef 与「每次渲染同步最新值」的赋值'
  );
});

test('重开面板要显式回到根层（subdir 一并复位，列表按根层拉）', () => {
  const code = stripComments(SOURCE);
  const effectStart = code.indexOf('if (!visible) return;');
  const body = code.slice(effectStart, effectStart + 4000);
  assert.ok(/setSubdir\(''\)/.test(body), '重开时必须把 subdir 复位到根层');
  // refreshRef.current 是上次渲染的闭包，里面的 subdir 还是旧深目录，
  // 所以必须显式传 { subdir: '' }，否则会按旧目录拉列表而面包屑已回根层。
  assert.ok(
    /refreshRef\.current\([^)]*\{\s*subdir:\s*''\s*\}/.test(body),
    '重开时必须显式传 subdir:\'\' 给 refresh（否则会用旧闭包的深目录）'
  );
});
