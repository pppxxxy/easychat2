// 工作区面板与设置入口的源码断言（RN 渲染/原生分享依赖运行时，Node 进不去）。
// 钉住：面板存在、以 characterId 分沙盒、写操作受模式门控、Word 导出复用 docx
// 纯函数、设置页有入口。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('文件面板：根层按项目分组 + 逐层下钻（诉求④）', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  assert.ok(source.includes('groupWorkspaceFiles'), '根层按项目分组');
  assert.ok(source.includes('directoryChildren'), '逐层列出当前目录的直接子项');
  assert.ok(source.includes('breadcrumbsOf'), '面包屑定位当前目录');
  assert.ok(source.includes('setSubdir(group.prefix)'), '点项目卡进入该项目');
  assert.ok(source.includes('setSubdir(crumb.path)'), '面包屑可回上层');
  assert.ok(source.includes('workspace.panel.group.projects'), '项目分组标题走 i18n');
  assert.ok(source.includes('workspace.panel.breadcrumb.root'), '面包屑根名走 i18n');
  assert.ok(!/files\.map\(name => renderFileRow/.test(source), '不再把整条长路径一维平铺');
  // 查看文件是面板内的层，不再是一个独立 Modal（全局弹窗嵌套到此为止）。
  assert.ok(!source.includes('<Modal visible={viewerOpen}'), 'viewer 不再是独立 Modal');
  assert.ok(source.includes('renderViewerBody'), 'viewer 改为面板内渲染');
});

test('WorkspacePanel：可改门控 + 沙盒分维度 + 复用 docx/store', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  assert.ok(source.includes("mode === 'write'"), '写操作必须仅可改模式');
  // 面板不再自己拼 uri：换成后端接口，角色隔离由 store 以 characterId 分沙盒保证；
// ownerId 允许显式传入（打开面板解析出工作区角色后立即用新 id 刷新列表）。
  assert.ok(/listWorkspaceFiles\(\{ characterId: ownerId \}\)/.test(source), '列表按 characterId 分沙盒');
  assert.ok(/readWorkspaceFile\(\{ characterId, path/.test(source), '读取按 characterId 分沙盒');
  assert.ok(source.includes('createWorkspaceStore') && source.includes('describeWorkspaceRoot'),
    '根与后端按当前设置解析（应用内 / 外部文件夹）');
  assert.ok(!source.includes('expo-file-system/legacy'), '面板不得直连 legacy 文件系统：读写须经后端');
  assert.ok(source.includes('writeWorkspaceBinaryFile') && source.includes('buildDocxBytes'),
    'Word 导出复用 docx 纯函数与二进制写');
  assert.ok(source.includes('Sharing.shareAsync'), '分享接 expo-sharing');
  assert.ok(source.includes('animationType="slide"'), '面板为滑入式 Modal');
  assert.ok(/container:\s*\{[^}]*paddingTop/.test(source), '全屏容器需顶部内边距，避免标题/关闭贴到状态栏');
  // 工作区角色：打开时解析（未设置落到默认工作助手）+ 选择器可切换并写回设置。
  assert.ok(source.includes('resolveWorkspaceAssistant'), '打开面板解析工作区角色');
  // 断言必须钉住「解析路径」的专属串（resolved.id）——选择器路径里也有一处
  // patchWorkspaceSettings 调用，只查前缀会漏掉解析路径被拆掉的回归（注入验证抓出）。
  assert.ok(source.includes('patchWorkspaceSettings({ assistantCharacterId: resolved.id })'), '解析出的角色写回设置');
  assert.ok(source.includes('patchWorkspaceSettings({ assistantCharacterId: item.id })'), '选择角色写回设置');
  assert.ok(source.includes('getCharacterLibrary'), '选择器读取角色库');
  // 状态条重排后：角色选择收进状态条的角色芯片（打开既有选择器）。
  assert.ok(/onPress=\{openCharacterPicker\}/.test(source), '状态条角色芯片有选择入口');
  // 查看文件：两段（文件/历史改动）+ 历史从存储域读取 + 清空入口。
  assert.ok(source.includes("t('workspace.panel.viewFiles')"), '面板有查看文件入口');
  assert.ok(source.includes('getWorkspaceChanges'), '历史改动读取存储域');
  assert.ok(source.includes('clearWorkspaceChanges'), '历史可清空');
  assert.ok(source.includes("openViewer('history')") || source.includes("openViewer(tab)"), '分段切换走 openViewer');
});

test('SettingsScreen：工作区卡片打开的是单屏（不再是平级面板 Modal）', () => {
  // 工作区卡片 UI 在 settings/sections/WorkspaceSection.js；入口装配在 SettingsScreen。
  const card = readSource('src/settings/sections/WorkspaceSection.js');
  const settings = readSource('src/SettingsScreen.js');
  assert.ok(/setWorkspaceOpen\(true\)/.test(card), '卡片按钮打开工作区');
  assert.ok(settings.includes("from './workspace/screen/WorkspaceScreen.js'"), '设置页挂的是工作区单屏');
  assert.ok(settings.includes('<WorkspaceScreen'), '渲染工作区单屏');
  assert.ok(!settings.includes('<WorkspacePanel'), '设置页不得再直接渲染 WorkspacePanel');
  assert.ok(!settings.includes('<WorkspaceChat'), '设置页不得再直接渲染 WorkspaceChat');
});

test('SettingsScreen：选文件夹 + 命令开关都走 patch（不许整体 save 冲掉彼此）', () => {
  // 快赢2 后状态与写入逻辑在 settings/useWorkspaceSettings.js；工作区卡片 UI 在 WorkspaceSection。
  const source = readSource('src/settings/useWorkspaceSettings.js') + readSource('src/settings/sections/WorkspaceSection.js');
  assert.ok(/from '\.\.?\/workspace\/picker\.js'/.test(source), '接入选文件夹能力');
  assert.ok(source.includes('pickWorkspaceFolder()'), '调用系统目录选择器');
  assert.ok(/patchWorkspaceSettings\(\{ location:/.test(source), '文件夹走局部更新');
  assert.ok(/patchWorkspaceSettings\(\{ allowCommandExecution/.test(source), '命令开关走局部更新');
  // 改模式那次是最容易踩坑的地方：必须是 patch，不能是整体 save
  assert.ok(/await patchWorkspaceSettings\(\{ mode \}\)/.test(source), '改模式必须走 patchWorkspaceSettings');
  assert.equal(/saveWorkspaceSettings\(/.test(source), false, '设置页不得再整体写工作区设置');
  // 命令开关要有二次确认，且只在可改模式、非外部根时可点
  assert.ok(source.includes("t('settings.workspace.shell.confirm.title')"), '开启命令执行要二次确认');
  assert.ok(/disabled=\{workspaceMode !== 'write' \|\| workspaceFolder\.kind === WORKSPACE_ROOT_KINDS\.SAF\}/.test(source),
    '只读模式或外部根下开关不可点');
  // 工作区卡片里的硬编码「打开工作区」必须已迁到 t()
  assert.equal(source.includes('title="打开工作区"'), false, '工作区卡片的按钮文案必须走 i18n');
});

test('WorkspacePanel：接入 i18n，零硬编码中文（注释除外）', async () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  assert.ok(source.includes('useTranslation'), '接入 useTranslation');
  assert.ok(/const \{ t \} = useTranslation\(\)/.test(source), '取 t');
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = [];
  // 注释要排除，**包括 JSX 的多行块注释**（{/* … */} 的中间行不以注释符开头，
  // 逐行判断时必须在块内状态里跳过——否则合法注释会被误报成硬编码中文）。
  let inBlockComment = false;
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[^*]*\*\//g, '');
    if (CJK.test(code)) offenders.push(`${index + 1}  ${trimmed.slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `WorkspacePanel 仍有硬编码中文：\n${offenders.join('\n')}`);

  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  const keys = Object.keys(zhCN).filter(key => key.startsWith('workspace.panel.'));
  assert.ok(keys.length >= 20, `workspace.panel.* 词条数量异常：${keys.length}`);
  assert.deepEqual(keys.filter(key => typeof en[key] !== 'string' || !en[key]), [], '英文缺词条');
  // 占位符中英一致
  const placeholders = text => (String(text).match(/\{(\w+)\}/g) || []).sort().join(',');
  const mismatched = keys.filter(key => placeholders(zhCN[key]) !== placeholders(en[key]));
  assert.deepEqual(mismatched, [], `占位符不一致：${mismatched.join(', ')}`);
  assert.ok(zhCN['chat.tool.status.reading'] && en['chat.tool.status.reading'], '工具气泡词条中英齐全');
  assert.equal(placeholders(zhCN['chat.tool.status.reading']), placeholders(en['chat.tool.status.reading']));
});
test('能力说明卡片：接入 i18n、零硬编码中文、按当前设置渲染', () => {
  const source = readSource('src/WorkspaceCapabilitiesCard.js');
  assert.ok(source.includes('useTranslation') && /const \{ t \} = useTranslation\(\)/.test(source), '接入 i18n');
  assert.ok(source.includes('capabilityViewModel'), '结构来自纯数据模块');
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[^*]*\*\//g, '');
    if (CJK.test(code)) offenders.push(`${index + 1}  ${trimmed.slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `能力说明卡片仍有硬编码中文：\n${offenders.join('\n')}`);
  // 设置页必须把它渲染进工作区卡片，并传入当前设置与 shell 可用性
  // （工作区卡片 UI 已拆到 settings/sections/WorkspaceSection.js）
  const settings = readSource('src/settings/sections/WorkspaceSection.js');
  assert.ok(settings.includes('<WorkspaceCapabilitiesCard'), '设置页渲染能力说明卡片');
  assert.ok(/settings=\{\{[\s\S]{0,200}allowCommandExecution: commandExecution/.test(settings), '传入当前工作区设置');
  assert.ok(/shellAvailable=\{isShellAvailable\(\)\}/.test(settings), '传入 shell 是否可用');
});

test('P4-2：思考强度与上下文占用收敛到单一来源（对话面板 ⚙），文件面板不再重复', () => {
  const files = readSource('src/workspace/screen/FilesPanel.js');
  const sheet = readSource('src/workspace/WorkspaceSettingsSheet.js');
  // 单一来源：对话面板的设置面板里两行都在，且都是可交互的
  assert.ok(sheet.includes("id: 'thinking'"), '思考强度行在设置面板');
  assert.ok(sheet.includes('onSelectThinking'), '思考强度可改（不是只读回显）');
  assert.ok(sheet.includes('t(`workspace.panel.thinking.${choice}`)'), '档位文案走词条');
  assert.ok(sheet.includes("id: 'usage'"), '上下文占用行在设置面板');
  assert.ok(sheet.includes("t('workspace.panel.context.usage', {"), '占用文案走词条（token 数与百分比）');
  assert.ok(sheet.includes("t('workspace.panel.context.empty')"), '无会话有空态文案');
  // 文件面板不得再出现第二处：那里是「文件」领域，调 agent 参数属于范畴错误，
  // 而且同一份数据两处显示必然会漂移（曾经的「调参」折叠卡）。
  assert.ok(!files.includes('THINKING_CHOICES'), '文件面板不再有思考强度 chips');
  assert.ok(!files.includes('computeContextUsage'), '文件面板不再自己算上下文占用');
  assert.ok(!files.includes('workspace.panel.tuning.title'), '「调参」折叠卡已移除');
  assert.ok(!files.includes('styles.contextFill'), '占用的进度条样式已随之下线');
});

test('F1/F2/F3 文件面板：子目录空状态 + 空目录可删（非空拦截）+ 项目卡路径前缀', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  // F1：子目录为空时渲染空状态（含返回上级）——以前是整屏空白，用户以为文件丢了
  assert.ok(source.includes("t('workspace.panel.empty.dir.title')"), '空目录空状态标题');
  assert.ok(source.includes("t('workspace.panel.empty.dir.back')"), '返回上级按钮');
  assert.ok(source.includes('parentDirectoryOf(subdir)'), '返回按钮走上一级纯函数');
  // F2：目录行有删除入口；非空目录拦截（UI 层门控，store 层还有第二道）
  assert.ok(source.includes('handleDeleteDirectory'), '目录删除入口存在');
  assert.ok(source.includes("t('workspace.panel.delete.dirNonEmpty.title')"), '非空目录有明确提示');
  assert.ok(source.includes('store.deleteWorkspaceDirectory'), '删除走 store 的空目录专用方法');
  assert.ok(
    source.includes("t('workspace.panel.delete.dirBody', { name: pendingDirDelete.label })"),
    '删除前有确认（说清影响与不可恢复）'
  );
  // F3：项目卡副标题带路径前缀（旧格式残留与真项目一眼分辨）+ 空组明确标注
  assert.ok(source.includes('{group.prefix}'), '副标题展示路径前缀');
  assert.ok(source.includes("t('workspace.panel.group.empty')"), '空组不再伪装成有内容的仓库');
});

test('D1 文件面板：导入文件到当前目录（技能生态通路，落点跟随 subdir）', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  assert.ok(source.includes('handleImportToCurrentDir'), '导入入口存在');
  assert.ok(
    source.includes('subdir ? `${subdir}${name}` : `imports/${name}`'),
    '落点跟随当前目录（根层沿用 imports/ 旧落点，不破坏老用户习惯）'
  );
  assert.ok(source.includes("t('workspace.panel.importFile')"), '按钮词条');
  assert.ok(source.includes('isTextLike'), '文本过滤（技能资源都是文本）');
  assert.ok(source.includes('await refresh()'), '导入后刷新列表');
});

test('F4 拉取提示与残留清单接线：保持前台提示 + 清单写/清（成功才清）', () => {
  const github = readSource('src/workspace/screen/GithubPanel.js');
  assert.ok(github.includes("t('workspace.github.pull.foregroundPreparing')"), '下载解压阶段提示保持前台');
  assert.ok(github.includes("t('workspace.github.pull.foreground', { eta: pullEta })"), '写入阶段带剩余秒数估算');
  assert.ok(github.includes("t('workspace.github.pull.resumeNote', { count: stale.files })"), '残留检测提示');
  // 顺序契约：先写清单、批结算之后才清——失败/取消路径（在清之前就跳出）保留清单，
  // 下次拉取才能检出「上次没跑完」。
  const writeAt = github.indexOf('await writePullManifest(');
  const clearAt = github.indexOf('await clearPullManifest(');
  const endBatchAt = github.indexOf('store.endBatch?.()');
  assert.ok(writeAt > 0 && clearAt > 0 && endBatchAt > 0, '写/清/批结算都在');
  assert.ok(writeAt < clearAt, '先写清单后清理');
  assert.ok(endBatchAt < clearAt, '清单在真正成功后才清（批结算之后）');
});

test('E5 历史浏览与 PR 接线：面板走 restApi、大 diff 截断、PR 先确认后创建', () => {
  const github = readSource('src/workspace/screen/GithubPanel.js');
  assert.ok(github.includes('await listCommits('), '提交历史走 restApi.listCommits');
  assert.ok(github.includes('await getCommitDiff('), 'diff 按 sha 拉取');
  assert.ok(github.includes('truncateDiffText(raw)'), '大 diff 复用头尾截断形状');
  assert.ok(github.includes("t('workspace.github.history.more')"), '分页可翻（加载更多）');
  assert.ok(github.includes('await createPullRequest('), 'PR 创建走 restApi.createPullRequest');
  // 写操作纪律：PR 必须先弹确认（head → base 说清），确认回调里才发请求。
  const confirmAt = github.indexOf("t('workspace.github.pr.confirmTitle')");
  const createAt = github.indexOf('await createPullRequest(');
  assert.ok(confirmAt > 0 && createAt > confirmAt, '先确认后创建（确认门在 UI 层）');
  // head = base 的无效场景要有拦截（在 main 上直接推时别发出必失败的请求）。
  assert.ok(github.includes("t('workspace.github.pr.badBranches'"), 'head === base 时明确提示');
});

test('G1/G2 推送删除安全 + 跳过可见 接线契约：基线注入 / 清单落盘 / 查看入口', () => {
  const github = readSource('src/workspace/screen/GithubPanel.js');
  // G1：推送前读基线并注入（「曾经物化过」的证据）——缺失时传空数组（removed 恒空）
  assert.ok(github.includes('await getRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`)'), '推送前读基线');
  assert.ok(github.includes('baselinePaths,'), '基线传入 pushRepoSnapshot');
  // G2：拉取完成后写清单（成功路径）；面板挂载读取（跨会话保留）
  assert.ok(github.includes('await writePullSkipped(store, characterId, skippedPayloadNext)'), '拉取成功后写跳过清单');
  assert.ok(github.includes('await readPullSkipped(storeRef && storeRef.current, characterId)'), '挂载时读清单');
  assert.ok(github.includes("t('workspace.github.skipped.view', { count: skippedPayload.total })"), '查看清单入口（带计数）');
  assert.ok(github.includes('formatSkippedList(skippedPayload)'), '清单文本用纯函数格式化');
  // 顺序契约：写清单在「清残留 manifest」之后（= 真正成功路径），失败/取消不写
  const clearManifestAt = github.indexOf('await clearPullManifest(store, characterId)');
  const writeSkippedAt = github.indexOf('await writePullSkipped(');
  assert.ok(clearManifestAt > 0 && writeSkippedAt > clearManifestAt, '清单只在成功路径写');
  // G 系超限记账：完成提示带「过大未参与同步」（不静默）
  assert.ok(github.includes("t('workspace.github.push.skippedTooLarge'"), '超大文件跳过如实提示');
});

test('H1/H2/H3 接线契约：云构建入口 / DiffView 渲染 / 回滚快照顺序', () => {
  const github = readSource('src/workspace/screen/GithubPanel.js');
  // H1：工具栏入口 + dispatch + 手动刷新列表 + 日志
  assert.ok(github.includes("t('workspace.github.toolbar.build')"), '工具栏有云构建入口');
  assert.ok(github.includes('await dispatchWorkflow('), '触发走 restApi');
  assert.ok(github.includes('await listWorkflowRuns('), '构建列表刷新');
  assert.ok(github.includes('await downloadRunLogs('), '日志下载');
  assert.ok(github.includes("t('workspace.github.build.needWorkflow')"), '空 workflow 有明确提示');
  // H2：diff 用 DiffView（unified 文本输入——E5 commit 详情升级）
  assert.ok(github.includes('<DiffView'), 'diff 走 DiffView 组件');
  assert.ok(github.includes('unified={historyDiff.text}'), 'unified 文本作为输入');
  // H3：推送成功写基线 + 回滚入口 + 应用恢复
  assert.ok(github.includes('writeRollbackSnapshot(store, characterId, payload)'), '推送成功写回滚基线');
  assert.ok(github.includes('applyRollbackSnapshot('), '回滚应用到本地');
  assert.ok(github.includes("t('workspace.github.rollback.action')"), '回滚入口（快照存在才显示）');
  assert.ok(github.includes('readLatestRollbackSnapshot(store, characterId)'), '回滚读最新快照');
  // 顺序契约（repoPush）：基线拉取在确认之后——用户取消就不拉（不白费网络）
  const push = readSource('src/workspace/repoPush.js');
  const confirmAt = push.indexOf('const proceed = await confirm({ diff, baselineMissing })');
  const rollbackAt = push.indexOf('const rollback = await collectRollbackEntries({');
  assert.ok(confirmAt > 0 && rollbackAt > confirmAt, '基线拉取在确认之后');
  // H2 分层：tools.js 的模块图不得被 diff/diffView 污染（分层炸弹测试另有守卫，
  // 这里钉住 DiffView 不进工具定义层）。
  const ciTools = readSource('src/workspace/toolDefs/ciTools.js');
  assert.ok(!ciTools.includes('react-native'), '工具定义层零 React 依赖');
  assert.ok(
    !/\bfrom\s+'[^']*restApi[^']*'/.test(ciTools),
    '工具定义层不静态 import 网络层（走 options.ci 注入；注释里提名字不算）'
  );
});

// G1 可见性（2026-10-10）：确认弹窗是「推送删除安全」的用户可见面——弹窗里少一句
// 警示，用户就不知道删除不可逆；少一句「无基线不删」，用户会把安全当常态。
// 这里是**结构守卫**：安全网的三个要素（永久删除警示 / 无基线说明 / 异常量二次确认）
// 被静默删掉时立刻红，而不是等真机上误删才发现。
test('G1 确认弹窗安全网：警示 + 无基线说明 + 异常删除量二次确认，三者缺一不可', () => {
  const panel = readSource('src/workspace/screen/GithubPanel.js');
  const push = readSource('src/workspace/repoPush.js');
  // ① 弹窗按「永久删除」警示与「保留原样」数量组织文案
  assert.ok(panel.includes('workspace.github.push.confirmDeleteWarn'), '必须警示删除不可逆');
  assert.ok(panel.includes('workspace.github.push.confirmRemoteOnly'), '必须说明未物化文件保持原样');
  // ② 无基线必须明说「本次不执行删除」（否则用户分不清「没要删的」与「没有基线所以不删」）
  assert.ok(panel.includes('workspace.github.push.confirmNoBaseline'), '无基线要有明确说明');
  assert.ok(push.includes('const baselineMissing ='), 'push 侧要把无基线事实算出来交给 UI');
  // ③ 异常放大（删除量 > 可删总数一半）→ 二次确认
  assert.ok(panel.includes('workspace.github.push.confirmAlarmBody'), '异常删除量要二次确认');
  assert.ok(/removed\.length \* 2 > knownRemoteCount/.test(panel), '二次确认的判据要写死在代码里');
  // ④ 清单本身要给全貌（条数 + 前若干条），不能只报数字
  assert.ok(/preview\.slice\(0, 12\)/.test(panel), '删除/新增清单要展示前若干条');
  // ⑤ 两个中英文词条必须都在（缺一个就是假承诺）
  for (const key of ['confirmDeleteWarn', 'confirmRemoteOnly', 'confirmNoBaseline', 'confirmAlarmTitle', 'confirmAlarmBody']) {
    const zh = readSource('src/i18n/locales/zh-CN/workspace.js');
    const en = readSource('src/i18n/locales/en/workspace.js');
    assert.ok(zh.includes(`workspace.github.push.${key}`), `中文缺 ${key}`);
    assert.ok(en.includes(`workspace.github.push.${key}`), `英文缺 ${key}`);
  }
});
