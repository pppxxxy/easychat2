// 桌面外壳结构守卫（S31）：异常状态行为的逐页核对。
//
// 这一轮查的是「正常路径之外」：损坏数据、并发写入、超长输入、能力缺失。
// 结论分三类，都写进下面的用例——
//
//   A. **已对齐（架构性）**：桌面页面不直接写存储（无 AsyncStorage.setItem / setJson
//      调用），全部走共享 API；串行队列与读守卫因此天然生效，不需要每页各写一遍。
//
//   B. **补上的缺口**：名称类输入无长度上限。存储层对书架名有 SHELF_NAME_MAX=40，
//      超长名会一路走到保存才被拒（用户得重新想名字）。根因是 desktop 的 TextInput
//      根本不支持 maxLength ——基础设施缺口，不是某个页面的疏忽。已在 TextInput
//      补 maxLength，并在书架名输入用起来。
//
//   C. **两端共同的既有缺陷（不属于「桌面落后手机」）**：
//      getDiaries() 在索引损坏时静默返回空数组（getDiariesStatus 才有 corrupt 态），
//      手机 DiaryPanel 与桌面 DiaryScreen 都用 getDiaries().catch(() => [])，
//      于是「损坏」显示成「还没有日记」。两端一致，不按移植差距处理，但记录在此，
//      避免将来有人以为只有桌面这样。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const SRC_FILES = walk(path.join(DESKTOP, 'src'));
const rel = full => path.relative(DESKTOP, full).replace(/\\/g, '/');
const readSrc = full => readFileSync(full, 'utf8');

// ---------------------------------------------------------------------------
// A. 并发写入：页面不直接碰存储
// ---------------------------------------------------------------------------
test('并发写入：桌面页面不直接写存储（串行队列与读守卫天然生效）', () => {
  const offenders = SRC_FILES
    .filter(file => {
      const text = readSrc(file);
      // 直接 setItem / setJson 会绕开共享层的 mutation 队列与「读失败不覆盖」守卫。
      return /AsyncStorage\.setItem\s*\(/.test(text) || /\bsetJson\w*\s*\(/.test(text);
    })
    .map(rel);
  assert.deepEqual(offenders, [], `这些文件绕过了共享写入队列：${offenders.join(', ')}`);
  // 共享层确实提供了队列与读守卫（桌面靠它，不是靠自觉）。
  const io = readRoot('src', 'storage', 'io.js');
  assert.ok(io.includes('createMutationQueue'), '共享层应提供串行写入队列');
});

// ---------------------------------------------------------------------------
// B. 超长输入：基础设施补 maxLength
// ---------------------------------------------------------------------------
test('超长输入：TextInput 支持 maxLength，且有上限的字段都用上了', () => {
  const ui = read('src', 'settings', 'ui.jsx');
  assert.ok(/maxLength = undefined/.test(ui), 'TextInput 应接受 maxLength');
  assert.ok(/maxLength=\{maxLength\}/.test(ui), 'TextInput 应把它传给 <input>');

  // 存储层有上限的字段：输入框必须同源截断，否则超长名会走到保存才被拒。
  const shelf = read('src', 'extension', 'screens', 'BookshelfPanel.jsx');
  assert.ok(shelf.includes('SHELF_NAME_MAX'), '书架名应使用共享上限常量');
  assert.ok(/maxLength=\{SHELF_NAME_MAX\}/.test(shelf), '书架名输入应传 maxLength');
  const shared = readRoot('src', 'books', 'shelves.js');
  assert.ok(/SHELF_NAME_MAX = 40/.test(shared), '上限常量应在共享层（唯一来源）');
});

// ---------------------------------------------------------------------------
// C. 损坏数据：页面不得把「读不出来」显示成「没有」
// ---------------------------------------------------------------------------
test('损坏数据：桌面核心页面都区分「读失败」与「空」，不静默清空', () => {
  // 这些页面自己读了存储，必须有失败分支（catch + 提示），不能 .catch(() => []) 了事。
  const mustHandle = [
    ['src/memory/MemoryListScreen.jsx', /corrupt|readFail/i],
    ['src/memory/MemoryProvenancePanel.jsx', /corrupt/],
    ['src/memory/MemoryCheckupPanel.jsx', /corrupt|error/i],
    ['src/extension/screens/MomentsScreen.jsx', /corrupt/],
    ['src/extension/screens/PluginScreen.jsx', /corrupt/],
    ['src/character/CharacterOverrideCard.jsx', /corrupt/],
  ];
  for (const [file, pattern] of mustHandle) {
    assert.ok(pattern.test(read(...file.split('/'))), `${file} 缺损坏/读失败分支`);
  }
});

test('损坏数据：日记的「静默空表」是两端共同的既有缺陷（记录，不按移植差距补）', () => {
  // getDiaries 只有值没有状态；损坏时 getDiariesStatus 返回 { status:'corrupt' }，
  // 但 getDiaries 把它吞成空数组。
  const shared = readRoot('src', 'storage', 'diary.js');
  assert.ok(/export async function getDiaries\(\)/.test(shared), '共享层应有 getDiaries');
  assert.ok(/const \{ diaries \} = await getDiariesStatus\(\)/.test(shared),
    'getDiaries 应在内部丢掉 status');
  // 两端都用同一个「吞掉」的入口 —— 所以这不是桌面单方面的差距。
  const mobile = readRoot('src', 'DiaryPanel.js');
  const desktop = read('src', 'extension', 'screens', 'DiaryScreen.jsx');
  for (const [name, text] of [['手机', mobile], ['桌面', desktop]]) {
    assert.ok(/getDiaries\(\)\.catch\(\(\) => \[\]\)/.test(text),
      `${name}端仍在用吞掉状态的方式读日记（若已修，请更新本断言）`);
  }
});

// ---------------------------------------------------------------------------
// D. 能力缺失：统一由扩展页的不可用清单承载
// ---------------------------------------------------------------------------
test('能力缺失：不可用入口集中在一处，页面不各自造降级 UI', () => {
  const reasons = read('src', 'extension', 'unsupportedReasons.js');
  assert.ok(reasons.includes('UNAVAILABLE_REASONS'), '应有集中的不可用原因表');
  // 页面侧只消费它的输出（不各自硬编码「暂不支持」）。
  const ext = read('src', 'extension', 'ExtensionScreen.jsx');
  assert.ok(ext.includes('unsupportedReason') || ext.includes('UNAVAILABLE_IDS'),
    '扩展页应消费集中清单');
});