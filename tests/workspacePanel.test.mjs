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

test('WorkspacePanel：思考强度与上下文占用接线钉死在源码', () => {
  const source = readSource('src/workspace/screen/FilesPanel.js');
  // 思考强度：四档 chips（off=关闭思考），点选立即保存，打开面板回读当前档位。
  assert.ok(source.includes("const THINKING_CHOICES = ['off', 'low', 'medium', 'high'];"), '四档可选');
  assert.ok(source.includes('saveThinkingSettings(next)'), '点选立即保存');
  assert.ok(source.includes("enabled: choice !== 'off'"), 'off 关闭思考');
  assert.ok(source.includes('t(`workspace.panel.thinking.${choice}`)'), '档位文案走词条');
  assert.ok(source.includes('getThinkingSettings()'), '打开时回读当前强度');
  // 上下文占用：与 ChatScreen.maybeAutoSummarize 同一口径；无会话显示空态。
  assert.ok(
    /import \{ AUTO_COMPACT_RATIO, computeContextUsage, resolveContextWindow \} from '(?:\.\.\/)+chat\/contextUsage\.js';/.test(source),
    '复用 contextUsage 纯口径'
  );
  // 钉住「过滤 + 排序」整体：两条相邻断言分别锁 type 过滤与 characterId 匹配，
  // 任何一条被拆掉都会漏占用（曾经靠注入验证抓过这类半截匹配）。
  assert.ok(
    source.includes(".filter(item => item && item.type !== 'group'"),
    '占用只统计单聊会话（排除群聊）'
  );
  assert.ok(
    source.includes("String(item.characterId || '') === String(ownerId || '')"),
    '占用取当前工作区角色的会话'
  );
  assert.ok(
    source.includes('declared: caps.contextWindow,'),
    '窗口按每模型声明的 contextWindow'
  );
  assert.ok(
    source.includes('usage.ratio >= AUTO_COMPACT_RATIO && styles.contextFillWarn'),
    '到 80% 线进度条转警示色'
  );
  assert.ok(
    source.includes("t('workspace.panel.context.usage', {"),
    '占用文案走词条（token 数与百分比）'
  );
  assert.ok(
    source.includes("t('workspace.panel.context.empty')"),
    '无会话有空态文案'
  );
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
    source.includes("t('workspace.panel.delete.dirBody', { name: label })"),
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
