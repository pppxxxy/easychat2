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
  'ModelCard.js',
  'DownloadTasks.js',
  'EngineCard.js',
  'AcquireSection.js',
  'ApiServerSection.js',
  'ModelParamsModal.js',
];
const PANEL = [SHELL, ...PANEL_FILES.map(readPanel)].join('\n');
const MODELS_SECTION = readPanel('ModelsSection.js');
const MODEL_CARD = readPanel('ModelCard.js');
const ACQUIRE_SECTION = readPanel('AcquireSection.js');
const DOWNLOAD_TASKS = readPanel('DownloadTasks.js');
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
  // getLocalModelIndex 出现在 refresh（条目列表）与 useApiServer.startApi（v5 Stage D
  // 把已装模型列表下发原生做 /v1/models）——两处都是读取，不下发编辑态。
  const callCount = (PANEL.match(/getLocalModelIndex[(][)]/g) || []).length;
  assert.equal(callCount, 2, 'getLocalModelIndex 应只在 refresh 与 startApi 各出现一次');
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

test('U4：下载进度条 + 取消按钮接线（v5 Stage B：走持久化队列）', () => {
  // 获取域经 downloadQueue 接线：入队 / 取消 / 订阅镜像任务态
  assert.ok(USE_ACQUIRE.includes('enqueueDownload'));
  assert.ok(USE_ACQUIRE.includes('cancelQueuedDownload'));
  assert.ok(USE_ACQUIRE.includes('subscribeDownloadQueue'));
  assert.ok(ACQUIRE_SECTION.includes("t('localModel.download.cancelA11y')"));
  // 进度条（非一行文字）+ 字节详情（单对象任务态 task.progress/totalBytes）
  assert.ok(ACQUIRE_SECTION.includes('downloadProgressBar'));
  assert.ok(ACQUIRE_SECTION.includes('task.totalBytes'));
  // 队列侧：登记表 + 幂等取消 + 编码错误仍在 modelManager
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

test('模型卡（v5 Stage C）：设为当前/参数 + ⋯ 菜单（加载/卸载、删除），常驻动作归位', () => {
  // 卡片原语：参数走 onEditParams，删除走 ⋯ 菜单里的 onDelete
  assert.ok(MODEL_CARD.includes('onEditParams(entry)'), '卡片「参数」应打开参数弹窗');
  assert.ok(MODEL_CARD.includes('onDelete(entry)'), '⋯ 菜单里的「删除」应接 onDelete');
  assert.ok(MODEL_CARD.includes('onUnloadModel(entry)') && MODEL_CARD.includes('onLoadModel(entry)'), '⋯ 菜单含加载/卸载');
  assert.ok(MODEL_CARD.includes('cardMenu'), '有 ⋯ 菜单');
  // 设为当前为主操作；当前态显示「已选用」
  assert.ok(MODEL_CARD.includes("t('localModel.card.setCurrent')") || MODEL_CARD.includes("t('localModel.selected')"));
  // 三态徽章：当前 / 已安装 / 未安装
  assert.ok(MODEL_CARD.includes("'localModel.badge.current'") && MODEL_CARD.includes("'localModel.badge.notInstalled'"));
  // 识图/听声/多模态并入单行摘要（不再用旧的多模态合并 chip）
  assert.ok(MODEL_CARD.includes("t('localModel.chip.noVision')") || MODEL_CARD.includes("t('localModel.chip.vision')"));
  // 未安装精选卡走「下载」入口
  assert.ok(MODEL_CARD.includes("t('localModel.card.download')"));
  // ModelsSection 组装三态卡 + 未安装精选卡
  assert.ok(MODELS_SECTION.includes('<ModelCard'));
  assert.ok(MODELS_SECTION.includes('featuredEntries'));
  assert.ok(MODELS_SECTION.includes('uninstalled'));
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
  // fail-closed（口径同 storage/worldMap.js 的「写前必读」）：读失败必须抛出、不写回。
  // 旧实现 `await getLocalModelSettings().catch(() => null)` 是 fail-open —— base 退化成
  // {}，对象 patch（服务域传整个 apiServer）会把 enabled/activeModelId/enableMediaInput
  // 一并抹掉。本断言原先把 .catch 形状钉死，随该缺陷修复一并改成 fail-closed 形状。
  assert.ok(USE_PANEL.includes('const base = await getLocalModelSettings();'),
    'updateSettings 必须裸读设置（读失败即抛出，不写回）');
  assert.ok(!USE_PANEL.includes('const latest = await getLocalModelSettings().catch'),
    '不得把读失败吞成 null（fail-open 整表覆盖）');
  assert.ok(USE_PANEL.includes("if (!base) throw new Error('local model settings unavailable')"),
    '读到空值也必须中止写回');
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


test('卡片删除接现成 confirmDelete（2026-10-07）：不另起删除逻辑', () => {
  assert.ok(MODEL_CARD.includes('onDelete(entry)'), 'ModelCard 删除应接 onDelete');
  assert.ok(MODEL_CARD.includes('trash-bin-outline'), '删除用 trash-bin 图标');
  // ModelsSection 把 onDeleteEntry 透传给卡片
  assert.ok(MODELS_SECTION.includes('onDelete={onDeleteEntry}'), 'ModelsSection 必须把 onDeleteEntry 透传给卡片');
  // 壳透传现成的 confirmDelete（已带确认弹窗 + 卸载 + 停服务 + 重置选用）
  assert.ok(SHELL.includes('onDeleteEntry={feedback.confirmDelete}'), '壳必须透传 feedback.confirmDelete');
  const styles = readPanel('panelStyles.js');
  assert.ok(/deleteIconButton:\s*\{[^}]*marginRight:\s*0/.test(styles), '删除按钮为行尾元素，marginRight 必须归零');
});

test('弹窗点外可取消（2026-10-07）：panelFeedback 全部弹窗走 alertCancelable', () => {
  const feedback = readPanel('panelFeedback.js');
  assert.ok(feedback.includes('const alertCancelable'), 'helper 必须存在');
  assert.ok(feedback.includes('{ cancelable: true, onDismiss: () => {} }'), 'helper 必须传 cancelable + onDismiss');
  assert.equal(feedback.split('Alert.alert(').length - 1, 1,
    '裸 Alert.alert 只允许在 helper 内部出现一次（新增弹窗必须走 helper）');
  assert.ok(feedback.includes('alertCancelable(entry.name || entry.id'), '长按操作单必须走可取消弹窗');
  assert.ok(feedback.includes('alertCancelable(t(\'localModel.alert.deleteModel.title\')'),
    '删除确认弹窗同样可点外取消（点外=取消，不误删）');
});

test('v5 §6：参数弹窗「高级」折叠——预设 + contextSize 单列，其余字段默认收起', () => {
  const MODAL = readPanel('ModelParamsModal.js');
  // 折叠分组：全字段里排除 contextSize（它单列在外、带回显内存代价）
  assert.ok(MODAL.includes("filter(field => field !== 'contextSize')"),
    '「高级」组应排除 contextSize');
  assert.ok(MODAL.includes('advancedOpen'), '折叠开关状态存在');
  assert.ok(MODAL.includes('{advancedOpen ? advancedFields.map(field => renderField(field)) : null}'),
    '高级字段只在展开时渲染（默认收起，避免一上来 7 个裸数字）');
  assert.ok(MODAL.includes("renderField('contextSize')"), 'contextSize 单列渲染');
  assert.ok(MODAL.includes("t('localModel.paramsModal.advanced')"), '折叠标题文案');
  assert.ok(MODAL.includes('contextMemoryHint()'), 'contextSize 的内存影响提示保留');

  const zhSrc = readFileSync(path.join(HERE, '..', 'src', 'i18n', 'locales', 'zh-CN', 'localModel.js'), 'utf8');
  const enSrc = readFileSync(path.join(HERE, '..', 'src', 'i18n', 'locales', 'en', 'localModel.js'), 'utf8');
  assert.ok(zhSrc.includes("'localModel.paramsModal.advanced'"), '中文文案在');
  assert.ok(enSrc.includes("'localModel.paramsModal.advanced'"), '英文文案在');
});

test('模型卡：分级为 tier 彩色文字（成品小样口径）+「设为当前」主操作实底', () => {
  // 成品小样里分级是文字（如「轻松跑」）带 tier 颜色——设计书 §6 曾写
  // 「只保留颜色不上文字」，两者冲突时以成品图为准（2026-10-09 用户指示看小样）。
  assert.ok(/tierColor\(theme, summary\.compatibility\.tier\)/.test(MODEL_CARD), '分级用 tier 颜色');
  assert.ok(MODEL_CARD.includes('${summary.compatibility.label}`}</Text>'),
    '分级文字直接显示（小样：Q4_K_M · 3B · 2.0GB · 识图 ✗ / … · 轻松跑）');
  assert.ok(MODEL_CARD.includes('accessibilityLabel={summary.compatibility'),
    '整行进 a11y（读屏完整拼出）');
  // 主操作层级：设为当前 = 实底；下载/参数 = 描边（小样里两者明显不同）
  assert.ok(MODEL_CARD.includes('styles.selectButtonPrimary'), '「设为当前」应为实底主操作');
  const styles = readPanel('panelStyles.js');
  assert.ok(/selectButtonPrimary:\s*\{[^}]*backgroundColor:\s*theme\.colors\.primary/.test(styles),
    '主操作实底用 primary');
});

test('v5 设计稿对齐：分段胶囊 / 运行卡三态（就绪绿）/ 状态条关闭钮', () => {
  const styles = readPanel('panelStyles.js');
  // ① 分段 = 独立胶囊（设计稿里没有外框）：激活反色实底、其余描边胶囊
  assert.ok(!/tabRow:\s*\{[^}]*backgroundColor/.test(styles), 'tabRow 不应再有外框底色');
  assert.ok(/tabItemActive:\s*\{[^}]*backgroundColor:\s*theme\.colors\.text/.test(styles),
    '激活胶囊应为反色实底（底=正文色）');
  assert.ok(/tabTextActive:\s*\{[^}]*theme\.colors\.background/.test(styles),
    '激活胶囊文字用背景色（深浅主题下都高对比）');
  assert.ok(/tabItem:\s*\{[\s\S]*?borderRadius:\s*tokens\.radius\.pill/.test(styles), '胶囊圆角');
  // ② 运行卡三态：就绪=success 绿、加载=品牌、失败=红
  for (const key of ['runCardReady', 'runCardLoading', 'runCardError', 'runDotReady', 'runDotLoading', 'runDotError', 'runBadgeReady']) {
    assert.ok(styles.includes(`${key}:`), `缺运行卡态样式：${key}`);
  }
  assert.ok(/runCardReady:\s*\{[^}]*theme\.colors\.success/.test(styles), '就绪运行卡 = success');
  const ENGINE_CARD = readPanel('EngineCard.js');
  assert.ok(ENGINE_CARD.includes('styles.runCardReady') && ENGINE_CARD.includes('styles.runDotReady'),
    'EngineCard 必须按 runtime.status 组合样式（不能写死一种配色）');
  // ③ 引擎状态条：✕ 关闭 + 就绪绿点 + 回退/出错警示配色
  const BAR = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'EngineStatusBar.js'), 'utf8');
  assert.ok(BAR.includes('setDismissed(true)'), '✕ 应能隐藏状态条');
  assert.ok(BAR.includes('setDismissed(false)'), '状态变化后应重新出现（不是永久关掉）');
  assert.ok(BAR.includes('styles.engineClose'), '关闭按钮样式接线');
  assert.ok(BAR.includes('theme.colors.success'), '就绪点用 success 绿（对齐设计稿）');
  assert.ok(BAR.includes('engineBarWarn'), '回退/出错切警示配色');
});

test('v5 §3：模型中心为全屏 Modal（非透明弹层）；弹层样式仍留给子弹窗', () => {
  assert.ok(SHELL.includes('<Modal visible={visible} animationType="slide" onRequestClose={onClose}>'),
    '全屏 Modal（不带 transparent）');
  assert.ok(SHELL.includes('styles.centerScreen'), '面板用全屏容器');
  assert.ok(!SHELL.includes('styles.sheet}'), '面板不再套 90% 高 sheet');
  const styles = readPanel('panelStyles.js');
  assert.ok(styles.includes('centerScreen:'), '全屏容器样式存在');
  // backdrop/sheet 是参数弹窗等子层在用的，不能跟着全屏化被删
  assert.ok(styles.includes('backdrop:') && styles.includes('sheet:'), '子弹窗弹层样式必须保留');
});

// ---- 2026-10-12 缺陷修复批：A/B/C/D/E ----

test('A：下载进度单位收口为 0–100（队列出口换算，消费方不再各自换算）', () => {
  const QUEUE = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'downloadQueue.js'), 'utf8');
  const MANAGER = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'modelManager.js'), 'utf8');
  // 唯一定义处：downloadQueue.toProgressPercent，写入 currentTask 时换算
  assert.ok(QUEUE.includes('export function toProgressPercent'), '队列应导出进度换算函数');
  assert.ok(QUEUE.includes('progress: toProgressPercent(progress)'), '快照写入时必须换算成百分数');
  assert.ok(QUEUE.includes('0–100'), '注释必须写明「进度一律 0–100」的单位口径');
  // 下载器保持 0–1 比值（换算不在这一层重复）
  assert.ok(MANAGER.includes('Math.min(1, written / total)'), '下载器仍产出 0–1 比值');
  // 两处消费方不再各自换算：DownloadTasks 直接用、AcquireSection 去掉 ×100
  assert.ok(!ACQUIRE_SECTION.includes('task.progress * 100'), 'AcquireSection 不得再 ×100');
  assert.ok(ACQUIRE_SECTION.includes('const downloadPercent ='), 'AcquireSection 直接用快照百分数');
  assert.ok(!DOWNLOAD_TASKS.includes('progress * 100'), 'DownloadTasks 不得再自行换算');
  assert.ok(DOWNLOAD_TASKS.includes('Number(task.progress) || 0'), 'DownloadTasks 直接用快照值');
});

test('B：取消下载用队列真实 task.id，不从草稿反推（死按钮 + 误取消根因）', () => {
  assert.ok(USE_ACQUIRE.includes('activeTaskIdRef'), '应镜像快照里的真实任务 id');
  assert.ok(USE_ACQUIRE.includes('activeTaskIdRef.current = String((current && current.id) || (pending && pending.id)'),
    '真实 id 必须来自快照的 current/pending');
  assert.ok(USE_ACQUIRE.includes('activeTaskIdRef.current = String(result.id || \'\')'),
    '入队成功后应记住队列返回的 id');
  assert.ok(!USE_ACQUIRE.includes('localModelIdFromFileName'),
    '取消路径不得再按文件名反推 id（该导入已移除）');
  const cancelRegion = USE_ACQUIRE.slice(USE_ACQUIRE.indexOf('const handleCancelDownload'));
  assert.ok(cancelRegion.includes('cancelQueuedDownload(id)'), '取消应传真实 id');
  assert.ok(cancelRegion.includes('if (!id) return Promise.resolve(false)'),
    '无已知任务 id 时不得取消任何任务（宁可无效也不能取消别人）');
});

test('C：设备内存透传到模型卡（兼容分级不再恒为「内存未知」）', () => {
  assert.ok(MODELS_SECTION.includes('deviceMemoryBytes'), 'ModelsSection 应接收设备内存');
  assert.ok(MODELS_SECTION.includes('deviceMemoryBytes={memoryBytes}'), '必须透传给 ModelCard');
  assert.ok(MODEL_CARD.includes('deviceMemoryBytes'), 'ModelCard 应接收设备内存');
  assert.ok(!MODEL_CARD.includes('totalMemoryBytes: 0'), '不得再把总内存硬编码成 0');
  assert.ok(MODEL_CARD.includes('totalMemoryBytes: deviceMemoryBytes'), '分级必须用真实内存');
});

test('D：精选卡 hasVision 来自 featured 目录（不再硬编码 false）', () => {
  assert.ok(USE_PANEL.includes('featuredCardEntry'), '精选卡条目应由 featured.featuredCardEntry 构造');
  assert.ok(!USE_PANEL.includes('hasVision: false'), '不得硬编码 hasVision:false');
  const FEATURED = readFileSync(path.join(HERE, '..', 'src', 'localModel', 'featured.js'), 'utf8');
  assert.ok(/repoId: 'unsloth\/gemma-3-4b-it-GGUF'[\s\S]{0,320}?hasVision: true/.test(FEATURED),
    'gemma3-4b（multimodal）必须在目录里标 hasVision:true');
});

test('E1：空态占位用专有词条（不再误用「查看运行日志」）', () => {
  assert.ok(MODELS_SECTION.includes("t('localModel.noActiveModel')"), '空态应用 noActiveModel');
  assert.ok(!MODELS_SECTION.includes("t('localModel.viewLogs')"), '不得再用 viewLogs 当空态占位');
  const zhSrc = readFileSync(path.join(HERE, '..', 'src', 'i18n', 'locales', 'zh-CN', 'localModel.js'), 'utf8');
  const enSrc = readFileSync(path.join(HERE, '..', 'src', 'i18n', 'locales', 'en', 'localModel.js'), 'utf8');
  assert.ok(zhSrc.includes("'localModel.noActiveModel'"), '中文词条要补');
  assert.ok(enSrc.includes("'localModel.noActiveModel'"), '英文词条要补');
});

test('E2：onPick 兼容 Promise 入参（PICK_FAILED 分支不再是死代码）', () => {
  const feedback = readPanel('panelFeedback.js');
  const region = feedback.slice(feedback.indexOf('const onPick'), feedback.indexOf('const onImport'));
  assert.ok(region.includes('const onPick = async'), 'onPick 必须 async');
  assert.ok(region.includes('await pickInput'), '必须 await 壳传入的 Promise');
  assert.ok(region.includes("code === 'PICK_FAILED'"), 'PICK_FAILED 分支保留');
  assert.ok(region.includes('catch (error)'), 'Promise reject 也要兜成 PICK_FAILED');
});

test('E3：重复入队透传 DUPLICATE（不再谎报「已加入队列」并清空草稿）', () => {
  const region = USE_ACQUIRE.slice(USE_ACQUIRE.indexOf('const handleDownload'), USE_ACQUIRE.indexOf('const handleCancelDownload'));
  assert.ok(region.includes("if (result.code === 'DUPLICATE') return { ok: false, code: 'DUPLICATE' }"),
    'DUPLICATE 必须透传给反馈层');
  const feedback = readPanel('panelFeedback.js');
  assert.ok(feedback.includes("result.code === 'DUPLICATE'"), '反馈层的 DUPLICATE 静默分支应可命中');
});
