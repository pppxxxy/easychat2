// 本地模型面板的代码质量守卫（2026-10-06 指令书 Phase 2a）：
// C4 删除已加载模型必须先卸载（否则 llama 上下文驻留内存、文件却被删）；
// C6 API 服务端口编辑态统一 string；C7 refresh 与可见性 effect 不再重复拉取。
// 面板是 UI 巨石，这里用源码锚点钉住关键顺序与口径；adapter 返回值有真实用例。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(path.join(HERE, '..', 'src', 'LocalModelPanel.js'), 'utf8');
const ADAPTER = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'adapter.js'), 'utf8');

test('adapter：无已加载模型时 unload 返回 true（真实调用）', async () => {
  const { unloadLocalModel } = await import('../src/localModel/adapter.js');
  assert.equal(await unloadLocalModel(), true);
});

test('adapter：unload 报告释放是否完全成功（返回值语义）', () => {
  assert.ok(ADAPTER.includes('return !releaseFailed'));
});

test('C4：删除已加载模型先停服务再卸载内存，卸载失败中止删除', () => {
  const start = PANEL.indexOf('const confirmDelete');
  const end = PANEL.indexOf('const [cleanupBusy');
  assert.ok(start > 0 && end > start, 'confirmDelete 区域定位失败');
  const region = PANEL.slice(start, end);
  // 关键顺序锚点：判加载 → 停服务 → 卸载 → 失败中止 → 删文件 → 删登记
  const loadedAt = region.indexOf('isLocalModelLoaded(item)');
  const stopAt = region.indexOf('stopLocalApiServer()');
  const unloadAt = region.indexOf('await unloadLocalModel()');
  const abortAt = region.indexOf('已中止删除');
  const deleteFileAt = region.indexOf('await deleteLocalModel(item)');
  const deleteItemAt = region.indexOf('await deleteLocalModelItem(entry.id)');
  for (const [label, at] of [['判加载', loadedAt], ['停服务', stopAt], ['卸载', unloadAt], ['中止', abortAt], ['删文件', deleteFileAt], ['删登记', deleteItemAt]]) {
    assert.ok(at > 0, `confirmDelete 缺少环节：${label}`);
  }
  assert.ok(loadedAt < stopAt && stopAt < unloadAt && unloadAt < abortAt
    && abortAt < deleteFileAt && deleteFileAt < deleteItemAt,
  '删除顺序必须是 判加载→停服务→卸载→（失败中止）→删文件→删登记');
  // 面板自己的「已加载」UI 态也要清
  assert.ok(region.includes('setLoadedModelId('));
});

test('C4 互链：聊天侧卸载路径有指向删除路径的注释', () => {
  const thinking = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useChatModelThinking.js'), 'utf8');
  assert.ok(thinking.includes('C4'));
});

test('C6：端口编辑态为 string，落盘时才转 number', () => {
  assert.ok(PANEL.includes("port: '8080'"), 'apiServer 初始端口应为字符串');
  assert.ok(PANEL.includes('Math.trunc(Number(apiServer.port))'), '落盘处应 parseInt 端口');
  assert.ok(PANEL.includes('port: String(current.apiServer.port'), '水合回填应转字符串');
});

test('C7：refresh 单一入口，水合 apiServer 仅发生在打开面板时', () => {
  // getLocalModelIndex 只剩 refresh 一处真实调用（import 行无括号，不干扰计数）
  const callCount = (PANEL.match(/getLocalModelIndex\(\)/g) || []).length;
  assert.equal(callCount, 1, 'getLocalModelIndex 应只在 refresh 里出现一次');
  assert.ok(PANEL.includes('refresh({ hydrateApi: true })'));
  assert.ok(PANEL.includes('options.hydrateApi === true'));
});

test('U1/U3：三段式分区 + 原生 Switch（假开关 pill 退役）', () => {
  // 三个分段
  assert.ok(PANEL.includes("localModel.tabs.models"));
  assert.ok(PANEL.includes("localModel.tabs.acquire"));
  assert.ok(PANEL.includes("localModel.tabs.serve"));
  // 获取段内两个互斥子 Tab（下载/导入）
  assert.ok(PANEL.includes("localModel.acquire.download"));
  assert.ok(PANEL.includes("localModel.acquire.import"));
  assert.ok(PANEL.includes("acquireTab === 'download'"));
  // 原生 Switch：启用/多媒体/ API 服务三处；假 toggle 样式已删
  const switchCount = (PANEL.match(/<Switch/g) || []).length;
  assert.equal(switchCount, 3, 'activeRow/mediaRow/API 服务应各有一个原生 Switch');
  assert.ok(!PANEL.includes('styles.toggle'), '假开关 toggle 样式引用应已清空');
  // 空列表给「去获取」引导
  assert.ok(PANEL.includes("localModel.empty.goAcquire"));
});

test('U2：下载与导入草稿分离，互斥子 Tab 切换各自保留', () => {
  assert.ok(PANEL.includes('emptyDownloadDraft'));
  assert.ok(PANEL.includes('emptyImportDraft'));
  assert.ok(PANEL.includes('useState(emptyDownloadDraft)'));
  assert.ok(PANEL.includes('useState(emptyImportDraft)'));
  // 不再存在混用的单一 draft
  assert.ok(!PANEL.includes('useState(emptyDraft)'), '单一 14 字段 draft 应已拆分');
  // 导入字段收进 importDraft（短名）
  assert.ok(PANEL.includes('importDraft.sourceUri'));
  assert.ok(PANEL.includes('importDraft.mmprojSourceUri'));
});
