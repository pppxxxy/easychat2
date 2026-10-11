// D3 轻量 Compaction 测试（纯函数 + 接线契约）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPACTION_FOCUS_MAX,
  COMPACTION_KEEP_RECENT,
  COMPACTION_MARKER,
  COMPACTION_PER_MESSAGE_MAX,
  COMPACTION_THRESHOLD_BYTES,
  COMPACTION_TRANSCRIPT_MAX,
  applyCompaction,
  buildCompactionSummaryRequest,
  buildCompactionSystemPrompt,
  compactionStatus,
  estimateMessagesBytes,
  formatBytes,
  normalizeCompactionFocus,
  parseCompactionSummary,
} from '../src/chat/compaction.js';

const msg = (role, text) => ({ id: `${role}-${text.length}`, role, text, at: 0 });

test('estimateMessagesBytes / compactionStatus：序列化体积口径 + 阈值', () => {
  assert.equal(estimateMessagesBytes([]), 2, "'[]' 长度");
  const small = [msg('user', 'hi')];
  assert.ok(estimateMessagesBytes(small) > 2);
  assert.equal(compactionStatus(small).due, false, '小会话不触发');
  assert.equal(
    compactionStatus([msg('user', 'x'.repeat(COMPACTION_THRESHOLD_BYTES))]).due,
    true,
    '超阈值触发'
  );
  assert.equal(estimateMessagesBytes(null), 2, '坏输入安全');
  assert.equal(compactionStatus(small, 10).due, true, '自定义阈值');
  // 体积线只有一个事实源：compactionStatus.due 与传入阈值同口径。
  assert.equal(compactionStatus(small, 10).threshold, 10);
});

// 回归 2026-10-11 逐行审查 P1：阈值曾是 4MB，**高于 Android 单值读取上限**。
// 一个会话的消息是单键整数组存盘，超过 CursorWindow 上限（约 2MB）后 getItem 直接抛错，
// 只能靠 readLargeAsyncStorageValue 的 SQLite 分块兜底；兜底失败 = 聊天记录永久读不出。
// 所以阈值必须留在「还读得动」的区间里，压缩要在撞上限之前发生。
test('回归：压缩阈值必须低于 Android 单值读取上限（约 2MB）', () => {
  const ANDROID_CURSOR_WINDOW_LIMIT = 2 * 1024 * 1024;
  assert.ok(
    COMPACTION_THRESHOLD_BYTES < ANDROID_CURSOR_WINDOW_LIMIT,
    `压缩阈值 ${COMPACTION_THRESHOLD_BYTES} 必须低于单值读取上限 ${ANDROID_CURSOR_WINDOW_LIMIT}`
  );
  // 2MB 的会话必须已经「该压缩」——否则它会在压缩触发之前就撞上读取上限。
  const twoMb = [msg('user', 'x'.repeat(ANDROID_CURSOR_WINDOW_LIMIT))];
  assert.equal(compactionStatus(twoMb).due, true, '2MB 会话必须已触发压缩');
});

test('formatBytes：B / KB / MB', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(999), '999B');
  assert.equal(formatBytes(2048), '2KB');
  assert.equal(formatBytes(4.5 * 1024 * 1024), '4.5MB');
});

test('buildCompactionSummaryRequest：system 三段式要求 + 转写 + 超长丢最旧', () => {
  const req = buildCompactionSummaryRequest([
    { role: 'user', text: '帮我看看', extra: 'ignored' },
    { role: 'assistant', text: '好的' },
    { role: 'system', text: '系统消息不进转写' },
    { role: 'user', text: '   ' },
  ]);
  assert.equal(req.length, 2);
  assert.match(req[0].content, /已完成/);
  assert.match(req[0].content, /关键决策与发现/);
  assert.match(req[0].content, /未完成与下一步/);
  assert.match(req[1].content, /用户：帮我看看/);
  assert.match(req[1].content, /助手：好的/);
  assert.equal(/系统消息/.test(req[1].content), false, 'system 不进转写');

  // 单条超长截断
  const long = buildCompactionSummaryRequest([{ role: 'user', text: 'x'.repeat(2000) }]);
  assert.ok(long[1].content.length <= COMPACTION_PER_MESSAGE_MAX + 10);

  // 总量超限：丢最旧的、保最新
  const many = Array.from({ length: 200 }, (unused, index) => msg('user', `第${index}条 ${'x'.repeat(400)}`));
  const capped = buildCompactionSummaryRequest(many);
  assert.ok(capped[1].content.length <= COMPACTION_TRANSCRIPT_MAX + 1000, '请求本身不爆');
  assert.ok(capped[1].content.includes('第199条'), '最新的一定在');
  assert.equal(capped[1].content.includes('第0条'), false, '最旧的被丢');
});

test('④：buildCompactionSummaryRequest 展开 toolTrace，摘要请求含工具转写', () => {
  const req = buildCompactionSummaryRequest([
    { id: 'u1', role: 'user', text: '读 a.js' },
    {
      id: 'a1',
      role: 'assistant',
      text: '读完了',
      toolTrace: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"a.js"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'file body' },
      ],
    },
  ]);
  assert.match(req[1].content, /调用了 read_workspace_file：a\.js/, '工具转写进入摘要请求');
});

test('applyCompaction：摘要消息 + 最近 K 条原文（保序）；空/keep=0 安全', () => {
  const list = Array.from({ length: 20 }, (unused, index) => msg(index % 2 === 0 ? 'user' : 'assistant', `消息${index}`));
  const next = applyCompaction(list, '已完成：A\n关键决策与发现：B\n未完成与下一步：C');
  assert.equal(next.length, 1 + COMPACTION_KEEP_RECENT);
  assert.equal(next[0].role, 'assistant');
  assert.ok(next[0].text.startsWith(COMPACTION_MARKER));
  assert.ok(next[0].id.startsWith('compaction-'));
  assert.deepEqual(
    next.slice(1).map(item => item.text),
    list.slice(-COMPACTION_KEEP_RECENT).map(item => item.text),
    '最近 K 条按原顺序保留'
  );
  assert.equal(applyCompaction([], 'x').length, 1, '空输入只有摘要');
  assert.equal(applyCompaction(list, 'x', 0).length, 1, 'keep=0 只有摘要');
});

test('parseCompactionSummary / compactionStatus：trim 与体积概览', () => {
  assert.equal(parseCompactionSummary('  a\n b  '), 'a\n b');
  assert.equal(parseCompactionSummary(null), '');
  const status = compactionStatus([msg('user', 'hi')]);
  assert.ok(status.bytes > 0 && status.sizeText);
  assert.equal(status.due, false);
  assert.equal(
    compactionStatus([msg('user', 'x'.repeat(COMPACTION_THRESHOLD_BYTES + 10))]).due,
    true,
    '超阈值时给设置页「该压缩了」信号'
  );
});

test('D3 接线契约：ChatScreen 手动压缩 + 设置弹窗入口 + 失败不动会话', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  assert.ok(screen.includes('handleCompactSession'), '压缩 handler 存在');
  assert.ok(screen.includes('stream: false'), '压缩走一次非流式模型调用');
  assert.ok(screen.includes('runSessionCompaction({'), 'N2 整合：走四档管线（L0 修剪/L1 K1 清除/L2 摘要/L3 归档）');
  assert.ok(screen.includes('setMessages(compacted.messages)'), '成功才替换消息数组');
  assert.ok(screen.includes("t('chat.settings.compactFail')"), '失败明确提示');
  assert.ok(screen.includes('compactInfo={compactInfo}'), '体积概览传给设置弹窗');
  const modal = fs.readFileSync(path.resolve('src/chat/ChatSettingsModal.js'), 'utf8');
  assert.ok(modal.includes("t('chat.settings.compact'"), '设置入口（带体积）');
  assert.ok(modal.includes('onCompactSession'), '触发回调');
});

test('E2 压缩自动化接线：silent 模式 + 85% 空闲自动触发 + 70% 提示条 + 设置开关', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  // silent 模式：自动路径不弹窗、返回结果对象供调用方决策；防重入走 ref
  assert.ok(screen.includes('options && options.silent === true'), 'handleCompactSession 支持 silent');
  assert.ok(screen.includes('compactBusyRef.current = true'), '防重入走 ref（异步闭包里 state 不可靠）');
  assert.ok(!screen.includes('if (compactBusy) return;\n    const list ='), '旧的 state 防重入已换成 ref 版');
  // 自动触发：空闲时静默压缩——不放发送路径（避免「压缩替换消息」与「发送读消息」竞态）。
  // Z 系采纳 #5：触发口径从固定 85% 改为 token 预算，触发逻辑外提到 useAutoCompact。
  assert.ok(screen.includes("import useAutoCompact from './chat/useAutoCompact.js';"), '自动触发已外提');
  assert.ok(screen.includes('useAutoCompact({'), '聊天页接线');
  assert.ok(screen.includes('enabled: chatOptions.autoCompact'), '系统设置可关（缺省开）');
  const autoCompact = fs.readFileSync(path.resolve('src/chat/useAutoCompact.js'), 'utf8');
  assert.ok(autoCompact.includes('enabled === false'), '开关关时不触发');
  // Z/M/D 整合：阈值唯一来源 compactionPolicy；字节规则与 token 规则取更严者；失败上限。
  assert.ok(autoCompact.includes('shouldCompactAnyRule('), '双规则取严（字节 + token）');
  assert.ok(autoCompact.includes('shouldStopAutoCompact(failuresRef.current)'), '连续失败达上限即停');
  assert.ok(autoCompact.includes('maxOutputTokens: modelOutputCap'), '按模型声明的输出上限预留');
  assert.ok(autoCompact.includes('if (isSending || compactBusyRef.current) return;'), '发送中/压缩中不触发');
  // 微压缩只留 loop 的 K1：Z 系 microcompact 已删除，不再有两套。
  assert.equal(autoCompact.includes('microcompactMessages'), false, 'Z 系就地截断式微压缩已移除');
  assert.ok(autoCompact.includes('onCompact({ silent: true })'), '自动路径走 silent');
  assert.ok(
    autoCompact.includes('attemptRef.current === messages.length'),
    '同一消息条数只尝试一次（失败不重试、防死循环）'
  );
  // 70% 非阻塞提示条（手动入口 + 可忽略）
  assert.ok(screen.includes('contextUsageRatio >= SESSION_COMPACT_HINT_RATIO'), '70% 提示条走具名常量');
  assert.ok(screen.includes("t('chat.compact.hint'"), '提示条文案（带占用百分比）');
  assert.ok(screen.includes("t('chat.compact.action')"), '一键压缩按钮');
  assert.ok(screen.includes('setCompactHintDismissed(true)'), '可忽略提示');

  // 设置开关：体验区 Switch + 存储归一（默认开）
  const section = fs.readFileSync(path.resolve('src/settings/sections/ExperienceSection.js'), 'utf8');
  assert.ok(section.includes("updateChatOption('autoCompact', value)"), '体验区开关接线');
  const options = fs.readFileSync(path.resolve('src/storage/settings/chatOptions.js'), 'utf8');
  assert.ok(options.includes('autoCompact: source.autoCompact !== false'), '缺省开启（只有显式 false 才关）');
});

// 把 `const NAME = useCallback(async (…` 起到配对的 `]);` 整段抠出来（按花括号计数）。
// ChatScreen 依赖 RN 运行时，Node 进不去，接线只能钉源码——但「整段抠出来再断言」比
// 「在整文件里 includes」强得多：后者会被注释、别处的同名变量、甚至被删掉的调用点骗过。
function extractCallback(source, name) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `找不到 ${name} 的 useCallback 定义`);
  // 函数体起点必须取 `) => {` 的那个 `{`——直接 indexOf('{') 会撞上默认参数里的 `{}`
  //（`useCallback(async (options = {}) => {`），花括号计数会当场归零，切出一段废文本。
  const arrow = source.indexOf(') => {', start);
  assert.notEqual(arrow, -1, `${name} 不是 async 箭头函数形态`);
  let depth = 0;
  let index = arrow + 5;
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.ok(index > bodyStart, `${name} 的函数体没找到结尾`);
  // 连同后面的依赖数组一起带上（`}, [...]);`）
  const tail = source.indexOf(']);', index);
  assert.notEqual(tail, -1, `${name} 的依赖数组没找到`);
  return source.slice(start, tail + 3);
}

// 回归 2026-10-11 审查 P1-5：防重入的检查原先在 `await resolveCompactionFocus(...)` **之后**，
// 两次并发触发（提示条 + 自动路径，或用户连点）会双双通过检查、双双走完流程，
// 于是**重复发一次 LLM 摘要请求**（花钱，且两次结果互相覆盖）。
// 光把检查挪到首行不够——检查与置位之间只要还有 await，两者仍能同时通过，
// 所以断言必须同时钉住「检查在最前」与「置位也在任何 await 之前」。
test('回归 P1-5：压缩防重入的检查与占位都在任何 await 之前（不允许重复发摘要请求）', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  const body = extractCallback(screen, 'handleCompactSession');
  // 必须剥掉行注释再量位置：本函数上方那段说明里就写着「在任何 await 之前」，
  // 不剥的话 indexOf('await ') 会命中注释、把断言变成永远失败（或永远通过）。
  const code = body.replace(/\/\/[^\n]*/g, '');

  const guardAt = code.indexOf('if (compactBusyRef.current) return');
  const claimAt = code.indexOf('compactBusyRef.current = true');
  const firstAwaitAt = code.indexOf('await ');
  const resolveFocusAt = code.indexOf('await resolveCompactionFocus(');

  assert.notEqual(guardAt, -1, '必须有防重入检查');
  assert.notEqual(claimAt, -1, '必须占位（防重入走 ref）');
  assert.notEqual(firstAwaitAt, -1, '这个函数本来就该有 await');
  assert.ok(guardAt < firstAwaitAt, '防重入检查必须在**任何 await 之前**');
  assert.ok(claimAt < firstAwaitAt, '占位也必须在任何 await 之前（否则检查与置位之间会被并发穿过）');
  assert.ok(guardAt < resolveFocusAt && claimAt < resolveFocusAt,
    '两者都要在 await resolveCompactionFocus 之前——那正是原 bug 的时序');
  // 只有一处检查（不许留着「检查在首行、旧检查又在中途」这种双份写法）。
  assert.equal(code.split('if (compactBusyRef.current) return').length - 1, 1, '防重入检查只允许一处');
  // 释放仍在 finally 里（异常路径也要解锁，否则一次失败会永久锁死）。
  assert.ok(/finally\s*\{[^}]*compactBusyRef\.current = false/.test(code), 'finally 里释放占位');
});

// 回归 2026-10-11 审查 P1-6：`handleCompactSession` 的依赖数组里带着 `messages`，而它每次
// 流式更新都会换引用 → useCallback 跟着重建 → 它作为 useAutoCompact 的 `onCompact` 进了那个
// effect 的依赖 → **每个 token 都让 effect 白跑一遍判定**（effect 里真正需要的是 messages.length，
// 已单独在依赖里）。删掉 `messages` 依赖的前提是函数体不再直接读它（否则会读到旧数组），
// 所以两条一起断言。
test('回归 P1-6：压缩回调不依赖 messages（否则流式每帧重建回调、effect 白跑判定）', () => {
  const screen = fs.readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  const body = extractCallback(screen, 'handleCompactSession');
  const depsMatch = body.match(/\},\s*\[([^\]]*)\]\s*\);\s*$/);
  assert.ok(depsMatch, '找到 handleCompactSession 的依赖数组');
  const deps = depsMatch[1].split(',').map(item => item.trim()).filter(Boolean);
  assert.equal(deps.includes('messages'), false, 'messages 不得出现在依赖里（它是每帧换引用的数组）');
  assert.ok(deps.includes('messagesRef'), 'messagesRef 仍在（稳定引用，回调靠它读当前消息）');
  // 函数体不得直接读 messages：删了依赖还读它，就会读到上一次渲染的旧数组（隐蔽 bug）。
  // 注意要排除**属性访问**（`compacted.messages` 是 runSessionCompaction 的返回值字段，
  // 与被删掉的那个闭包变量无关）——所以只匹配「前面不是点号」的 messages。
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/messagesRef/g, 'REF');
  assert.equal(/(^|[^.\w])messages\b/.test(code), false, '函数体只许通过 messagesRef 读消息');
  // useAutoCompact 侧确实把 onCompact 放进了依赖——所以上面的重建代价是真的（不是理论担忧）。
  const autoCompact = fs.readFileSync(path.resolve('src/chat/useAutoCompact.js'), 'utf8');
  assert.ok(/onCompact,\s*\]/.test(autoCompact), 'onCompact 在 effect 依赖里（回调重建会让 effect 重跑）');
});

// ---- 关注点（focus）：/compact 后面那句「这次要特别保留什么」----

test('normalizeCompactionFocus：空白折叠、超长截断、空值归一为空串', () => {
  assert.equal(normalizeCompactionFocus(undefined), '');
  assert.equal(normalizeCompactionFocus(null), '');
  assert.equal(normalizeCompactionFocus('   '), '');
  assert.equal(normalizeCompactionFocus('重点\n保留   API 变更'), '重点 保留 API 变更');
  assert.equal(normalizeCompactionFocus('x'.repeat(500)).length, COMPACTION_FOCUS_MAX);
});

test('buildCompactionSystemPrompt：无关注点时与基础提示词逐字节一致', () => {
  const base = buildCompactionSystemPrompt();
  assert.equal(buildCompactionSystemPrompt(''), base, '空串 = 基础提示词');
  assert.equal(buildCompactionSystemPrompt('   '), base, '纯空白 = 基础提示词');
  assert.ok(base.includes('三段中文摘要'));
  assert.ok(!base.includes('额外要求'), '没有关注点就不该出现额外要求');
});

test('buildCompactionSystemPrompt：有关注点时追加额外要求，且不改输出格式', () => {
  const withFocus = buildCompactionSystemPrompt('重点保留 API 变更与未决问题');
  assert.ok(withFocus.includes('额外要求'));
  assert.ok(withFocus.includes('重点保留 API 变更与未决问题'));
  assert.ok(withFocus.includes('三段中文摘要'), '基础结构说明仍在（不是替换）');
  assert.ok(withFocus.includes('输出格式不变'), '明确不改变输出格式，防模型改写成别的形态');
});

test('buildCompactionSummaryRequest：focus 只影响 system，转写内容不受影响', () => {
  const messages = [msg('user', '甲'), msg('assistant', '乙')];
  const plain = buildCompactionSummaryRequest(messages);
  const focused = buildCompactionSummaryRequest(messages, { focus: '保留报错原文' });
  assert.deepEqual(focused[1], plain[1], 'user 转写逐字节一致');
  assert.notEqual(focused[0].content, plain[0].content);
  assert.ok(focused[0].content.includes('保留报错原文'));
  assert.deepEqual(buildCompactionSummaryRequest(messages)[0], plain[0], '不传 options 走基础提示词');
});
