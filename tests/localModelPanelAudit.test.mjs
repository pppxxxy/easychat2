// 本地模型面板的代码质量守卫（2026-10-06 指令书 Phase 2a/2b）：
// C4 删除已加载模型必须先卸载（否则 llama 上下文驻留内存、文件却被删）；
// C6 API 服务端口编辑态统一 string；C7 条目刷新与服务水合分离；
// C1 拆分后的文件规模上限；C3 设置更新收口；C5 formatBytes 合一；
// U1-U6 排版改造的结构锚点。
// 拆分后面板逻辑分布在 壳（LocalModelPanel.js）+ panel/ 目录；审计锚点读拼接源，
// 对文件在壳与 panel/ 之间的迁移保持稳健。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readPanel = name => readFileSync(path.join(HERE, '..', 'src', 'localModel', 'panel', name), 'utf8');
const SHELL = readFileSync(path.join(HERE, '..', 'src', 'LocalModelPanel.js'), 'utf8');
const PANEL_FILES = [
  'panelShared.js',
  'acquireReducer.js',
  'usePanelModels.js',
  'useAcquireModel.js',
  'useApiServer.js',
  'useModelParams.js',
  'panelFeedback.js',
  'panelStyles.js',
  'ModelsSection.js',
  'AcquireSection.js',
  'ApiServerSection.js',
  'ModelParamsModal.js',
];
const PANEL = [SHELL, ...PANEL_FILES.map(readPanel)].join('\n');
const MODELS_SECTION = readPanel('ModelsSection.js');
const ACQUIRE_SECTION = readPanel('AcquireSection.js');
const USE_ACQUIRE = readPanel('useAcquireModel.js');
const USE_API = readPanel('useApiServer.js');
const USE_PANEL = readPanel('usePanelModels.js');
const ADAPTER = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'adapter.js'), 'utf8');

test('adapter：无已加载模型时 unload 返回 true（真实调用）', async () => {
  const { unloadLocalModel } = await import('../src/localModel/adapter.js');
  assert.equal(await unloadLocalModel(), true);
});

test('adapter：unload 报告释放是否完全成功（返回值语义）', () => {
  assert.ok(ADAPTER.includes('return !releaseFailed'));
});

test('C4：删除已加载模型先停服务再卸载内存，卸载失败中止删除', () => {
  // 删除链已从壳抽到 panel/panelFeedback.js：锚点在拼接源上找，对迁移稳健。
  const start = PANEL.indexOf('const confirmDelete');
  const end = PANEL.indexOf('// 长按操作单（U6）');
  assert.ok(start > 0 && end > start, 'confirmDelete 区域定位失败');
  const region = PANEL.slice(start, end);
  // 关键顺序锚点：判加载 → 停服务 → 卸载 → 失败中止 → 删文件 → 删登记
  const loadedAt = region.indexOf('isLocalModelLoaded(item)');
  const stopAt = region.indexOf('stopLocalApiServer()');
  const unloadAt = region.indexOf('await unloadLocalModel()');
  const abortAt = region.indexOf('localModel.alert.unloadFailed.title');
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
  assert.ok(USE_API.includes("port: '8080'"), 'apiServer 初始端口应为字符串');
  assert.ok(USE_API.includes('Math.trunc(Number(apiServer.port))'), '落盘处应 parseInt 端口');
  assert.ok(USE_API.includes('port: String(current.apiServer.port'), '水合回填应转字符串');
});

test('C7：条目刷新与服务水合分离，编辑态只在水合时回填', () => {
  // getLocalModelIndex 只剩 usePanelModels.refresh 一处真实调用
  const callCount = (PANEL.match(/getLocalModelIndex[(][)]/g) || []).length;
  assert.equal(callCount, 1, 'getLocalModelIndex 应只在 refresh 里出现一次');
  // 服务域水合只在 useApiServer.hydrate；打开面板时由壳触发一次
  assert.ok(SHELL.includes('api.hydrate()'));
  assert.ok(USE_API.includes('const hydrate = useCallback'));
  // usePanelModels 绝不回填服务编辑态
  assert.ok(!USE_PANEL.includes('setApiServer'), 'refresh 不得触碰 apiServer 编辑态');
});

test('U1/U3：三段式分区 + 原生 Switch（假开关 pill 退役）', () => {
  assert.ok(SHELL.includes('localModel.tabs.models'));
  assert.ok(SHELL.includes('localModel.tabs.acquire'));
  assert.ok(SHELL.includes('localModel.tabs.serve'));
  // 获取段内两个互斥子 Tab（下载/导入）——标签在 AcquireSection
  assert.ok(ACQUIRE_SECTION.includes('localModel.acquire.download'));
  assert.ok(ACQUIRE_SECTION.includes('localModel.acquire.import'));
  // 原生 Switch：启用/多媒体（ModelsSection 两处 SwitchRow）+ API 服务一处；假 toggle 样式已删
  const API_SECTION = readPanel('ApiServerSection.js');
  assert.ok((MODELS_SECTION.match(/<SwitchRow/g) || []).length >= 2, '启用/多媒体应各有一个 SwitchRow');
  assert.ok(API_SECTION.includes('<Switch'), 'API 服务应有原生 Switch');
  assert.ok(!PANEL.includes('styles.toggle'), '假开关 toggle 样式引用应已清空');
  // 空列表给「去获取」引导
  assert.ok(SHELL.includes('localModel.empty.goAcquire'));
});

test('U2：下载与导入草稿分离，互斥子 Tab 切换各自保留', () => {
  assert.ok(USE_ACQUIRE.includes('downloadDraft: emptyDownloadDraft()'));
  assert.ok(USE_ACQUIRE.includes('importDraft: emptyImportDraft()'));
  assert.ok(USE_ACQUIRE.includes('importDraft.sourceUri'));
  assert.ok(USE_ACQUIRE.includes('importDraft.mmprojSourceUri'));
  assert.ok(!PANEL.includes('useState(emptyDraft)'), '单一 14 字段 draft 应已拆分');

  // useReducer 状态机：状态迁移全部走类型化 action（reducer 在独立纯模块里，行为直测）
  const REDUCER = readPanel('acquireReducer.js');
  assert.ok(USE_ACQUIRE.includes("from './acquireReducer.js'"), '获取域应使用状态机');
  assert.ok(!USE_ACQUIRE.includes('useState('), '获取域不再散落 useState');
  for (const type of ['tab', 'downloadDraft', 'importDraft', 'task']) {
    assert.ok(REDUCER.includes(`case '${type}':`), `reducer 缺 action：${type}`);
  }
  assert.ok(REDUCER.includes('nextValue'), 'reducer 必须兼容函数式更新（与 useState 语义一致）');
  assert.ok(REDUCER.includes("kind: ''"), '空闲任务态 kind 为空');
});

test('U4：下载进度条 + 取消按钮接线', () => {
  assert.ok(USE_ACQUIRE.includes('cancelLocalModelDownload'));
  assert.ok(USE_ACQUIRE.includes('handleCancelDownload'));
  assert.ok(ACQUIRE_SECTION.includes("t('localModel.download.cancelA11y')"));
  // 进度条（非一行文字）+ 字节详情（单对象任务态 task.progress/totalBytes）
  assert.ok(ACQUIRE_SECTION.includes('downloadProgressBar'));
  assert.ok(ACQUIRE_SECTION.includes('task.totalBytes'));
  // 取消按编码区分：hook 识别 DOWNLOAD_CANCELLED，反馈层对 CANCELLED 不弹错误
  assert.ok(USE_ACQUIRE.includes("code === 'DOWNLOAD_CANCELLED'"));
  assert.ok(PANEL.includes("result.code === 'CANCELLED'"));
  // modelManager 侧：登记表 + 幂等取消 + 编码错误
  const manager = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'modelManager.js'), 'utf8');
  assert.ok(manager.includes('activeDownloads'));
  assert.ok(manager.includes('export async function cancelLocalModelDownload'));
  assert.ok(manager.includes("cancelError.code = 'DOWNLOAD_CANCELLED'"));
});

test('U5：搜索选中静默回填，仅「跑不了」档弹警示', () => {
  // hook 只回填并返回摘要，自身不弹任何 Alert
  const start = USE_ACQUIRE.indexOf('const handleSearchSelect');
  const region = USE_ACQUIRE.slice(start, USE_ACQUIRE.indexOf('const rewriteSource'));
  assert.ok(region.includes('buildModelSummary'));
  assert.ok(!region.includes('Alert.alert'), '选中回填应静默（反馈在 panelFeedback）');
  // 反馈层只在「跑不了」档警示
  assert.ok(PANEL.includes("summary.compatibility.tier !== 'incompatible'"));
});

test('U6：模型行长按操作单（参数/删除），常驻仅 选用/加载', () => {
  assert.ok(MODELS_SECTION.includes('onLongPress={() => onEntryActions(entry)}'));
  const start = PANEL.indexOf('const onEntryActions');
  const region = PANEL.slice(start, PANEL.indexOf('export function createParamsSaver'));
  assert.ok(region.includes('onEditParams(entry)'), '长按操作单里的「参数」应打开参数弹窗');
  assert.ok(region.includes('confirmDelete(entry)'));
  assert.ok(region.includes("t('localModel.chip.imported')"), '来源信息应进长按操作单副标题');
  // 常驻四按钮退役：展开机制与行内常驻 参数/删除 按钮已删
  assert.ok(!PANEL.includes('expandedId'), '展开/收起机制应已退役');
  // 行内只保留 选用/加载；识图/听声合并为多模态 chip（精确锚避免误伤提示文案）
  assert.ok(MODELS_SECTION.includes("t('localModel.chip.multimodal')"));
  assert.ok(!MODELS_SECTION.includes('>识图<'));
  assert.ok(!MODELS_SECTION.includes('>听声<'));
  assert.ok(!MODELS_SECTION.includes('options-outline'));
});

test('C1：拆分后壳只做组合与渲染，panel/ 组件各不超 300 行', () => {
  const shellLines = SHELL.split('\n').length;
  // 指令书目标 ≤200 已达成：反馈映射抽到 panel/panelFeedback.js、参数弹窗状态抽到
  // panel/useModelParams.js（i18n 全量清理后壳里已无硬编码文案，随之从
  // no-hardcoded-chinese 豁免清单移除）。这里按目标值钉死，防回涨。
  assert.ok(shellLines <= 200, `壳应保持 ≤200 行，当前 ${shellLines} 行`);
  // 反馈映射必须留在 panel/ 里（不是塞回壳）：壳只做接线。
  assert.ok(SHELL.includes('createPanelFeedback'), '壳应通过 panelFeedback 接线反馈');
  assert.ok(!SHELL.includes('Alert.alert'), '壳内不应再直接弹 Alert（统一走 panelFeedback）');
  for (const name of PANEL_FILES) {
    const lines = readPanel(name).split('\n').length;
    assert.ok(lines <= 300, `${name} 应 ≤300 行，当前 ${lines}`);
  }
});

test('C3：设置更新收口 updateSettings（重读最新再合并）', () => {
  assert.ok(USE_PANEL.includes('const updateSettings = useCallback'));
  assert.ok(USE_PANEL.includes('await getLocalModelSettings().catch(() => null)'));
  assert.ok(USE_PANEL.includes("typeof patch === 'function' ? patch(base) : patch"));
  // 既有手动合并点全部改走 updateSettings
  for (const anchor of [
    'applyActiveLocalModel(base, item)',
    'base => ({ ...base, enabled: !base.enabled })',
    'base => ({ ...base, enableMediaInput: !base.enableMediaInput })',
  ]) {
    assert.ok(USE_PANEL.includes(anchor), `缺少收口锚点：${anchor}`);
  }
  assert.ok(!USE_PANEL.includes('saveLocalModelSettings(applyActiveLocalModel'), '不得再用内存旧快照整表覆盖');
  assert.ok(USE_API.includes('await updateSettings(base => ({'), '服务域落盘也应走 updateSettings');
});

test('C5：formatBytes 四处副本合一（utils 为准，modelLogs 再导出）', () => {
  assert.ok(!PANEL.includes('const units = ['), '面板与 panel/ 不得再有本地 formatBytes 实现');
  const manager = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'modelManager.js'), 'utf8');
  assert.ok(manager.includes("import { formatBytes } from './modelLogs.js'"), 'modelManager 经 modelLogs 再导出继续可用');
});

test('U7：参数弹窗越界红框 + 恢复默认（单字段与全部）', () => {
  const MODAL = readPanel('ModelParamsModal.js');
  const PARAMS = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'modelParams.js'), 'utf8');
  // 即时校验是纯函数（可测），弹窗只映射文案
  assert.ok(PARAMS.includes('export function checkLocalModelParamField'));
  assert.ok(MODAL.includes('checkLocalModelParamField(field, form[field])'), '输入框样式应跟随即时校验');
  assert.ok(MODAL.includes('styles.inputError'), '越界要有红框');
  assert.ok(MODAL.includes("t('localModel.paramsModal.errRange'"), '越界要有行内说明');
  assert.ok(MODAL.includes("t('localModel.paramsModal.errNumber'"), '非数字也要提示');
  // 恢复默认：单字段 + 全部（都走 onFieldChange，与手输同一条路径）
  assert.ok(MODAL.includes('LOCAL_MODEL_PARAM_FIELDS[field].default'), '单字段恢复默认回填各自 default');
  assert.ok(MODAL.includes("t('localModel.paramsModal.reset')"), '单字段按钮文案');
  assert.ok(MODAL.includes('resetAll'), '全部恢复默认入口');
  assert.ok(MODAL.includes("t('localModel.paramsModal.resetAll')"), '全部恢复默认文案');
});

