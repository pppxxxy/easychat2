// H2：行级 diff（纯函数，Node 直测）——两个输入形态：
//   1) buildLineDiff(oldText, newText)：本地 vs 远程内容 → 行级 LCS（文件面板「与远程比对」用）；
//   2) parseUnifiedDiff(text)：远程 unified diff 文本（E5 commit 详情）→ 行数组。
// 两者产出同一种行模型，DiffView（WebView）统一渲染。
//
// 规模保护：LCS 是 O(n×m) 内存——单侧超过 LINE_DIFF_MAX_LINES 时退化为
// 「整体删除 + 整体新增」（coarse），并置 truncated 标记如实告知，绝不假装精细。
// 行模型：[{ type: 'ctx' | 'add' | 'del' | 'hunk' | 'file', text, oldNo?, newNo? }]

export const LINE_DIFF_MAX_LINES = 800;

function splitLines(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  // 尾换行不产生一个"空行差异"（编辑器常识：'a\n' 与 'a' 是同一内容）
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (value === '') return [];
  return value.split('\n');
}

function coarseDiff(oldLines, newLines) {
  const lines = [];
  oldLines.forEach((text, index) => {
    lines.push({ type: 'del', text, oldNo: index + 1 });
  });
  newLines.forEach((text, index) => {
    lines.push({ type: 'add', text, newNo: index + 1 });
  });
  return lines;
}

// 行级 LCS。返回 { lines, stats: { added, removed }, truncated }。
export function buildLineDiff(oldText, newText, { maxLines = LINE_DIFF_MAX_LINES } = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    const lines = coarseDiff(oldLines, newLines);
    return {
      lines,
      stats: { added: newLines.length, removed: oldLines.length },
      truncated: true,
    };
  }
  const n = oldLines.length;
  const m = newLines.length;
  // DP 表：dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度（Int32 存储控内存）。
  const dp = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  const push = item => {
    lines.push(item);
    if (item.type === 'add') added += 1;
    if (item.type === 'del') removed += 1;
  };
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      push({ type: 'ctx', text: oldLines[i], oldNo: i + 1, newNo: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push({ type: 'del', text: oldLines[i], oldNo: i + 1 });
      i += 1;
    } else {
      push({ type: 'add', text: newLines[j], newNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    push({ type: 'del', text: oldLines[i], oldNo: i + 1 });
    i += 1;
  }
  while (j < m) {
    push({ type: 'add', text: newLines[j], newNo: j + 1 });
    j += 1;
  }
  return { lines, stats: { added, removed }, truncated: false };
}

// unified diff 文本 → 行模型（E5 commit 详情）。
// 认这几种行首：'diff --git'（文件头）、'@@'（hunk 头）、'+'/'−'/' '（内容）；
// '---'/'+++' 是源/目标文件行（unified 协议），归 'file' 类不参与增删计数。
export function parseUnifiedDiff(text) {
  const lines = [];
  let added = 0;
  let removed = 0;
  for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let item;
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode')
      || line.startsWith('deleted file mode') || line.startsWith('similarity index')
      || line.startsWith('rename ')) {
      item = { type: 'file', text: line };
    } else if (line.startsWith('@@')) {
      item = { type: 'hunk', text: line };
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      item = { type: 'file', text: line };
    } else if (line.startsWith('+')) {
      item = { type: 'add', text: line.slice(1) };
      added += 1;
    } else if (line.startsWith('-')) {
      item = { type: 'del', text: line.slice(1) };
      removed += 1;
    } else if (line.startsWith('\\')) {
      item = { type: 'file', text: line }; // '\ No newline at end of file'
    } else {
      item = { type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
    }
    lines.push(item);
  }
  // 末尾空行（文本以 \n 结尾）不产生空行
  if (lines.length > 0 && lines[lines.length - 1].type === 'ctx' && lines[lines.length - 1].text === '') {
    lines.pop();
  }
  return { lines, stats: { added, removed } };
}

// 纯函数：行模型 → HTML（DiffView 的 WebView 内容）。转义在生成时完成（XSS 面收口）。
export function buildDiffHtml(model, { dark = false, title = '' } = {}) {
  const source = model && Array.isArray(model.lines) ? model.lines : [];
  const escape = value => String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const rows = source.map(item => {
    const kind = ['ctx', 'add', 'del', 'hunk', 'file'].includes(item.type) ? item.type : 'ctx';
    const oldNo = Number.isFinite(item.oldNo) ? String(item.oldNo) : '';
    const newNo = Number.isFinite(item.newNo) ? String(item.newNo) : '';
    const marker = kind === 'add' ? '+' : (kind === 'del' ? '-' : ' ');
    return `<div class="line ${kind}"><span class="no">${oldNo}</span><span class="no">${newNo}</span>`
      + `<span class="mark">${marker}</span><span class="code">${escape(item.text) || '&nbsp;'}</span></div>`;
  });
  const stats = model && model.stats ? model.stats : { added: 0, removed: 0 };
  const truncatedNote = model && model.truncated
    ? '<div class="note">文件过大，已退化为整体对比（不做逐行匹配）</div>'
    : '';
  const theme = dark
    ? {
      bg: '#1b1c1f', fg: '#d6d6d6', muted: '#6b6e76', border: '#2c2e33',
      addBg: 'rgba(63,185,80,0.15)', addFg: '#7ee787',
      delBg: 'rgba(248,81,73,0.14)', delFg: '#ffa198',
      hunkBg: 'rgba(56,139,253,0.12)', hunkFg: '#79c0ff', fileFg: '#8b949e',
    }
    : {
      bg: '#ffffff', fg: '#24292f', muted: '#8c959f', border: '#e5e7eb',
      addBg: 'rgba(46,160,67,0.12)', addFg: '#1a7f37',
      delBg: 'rgba(207,34,46,0.10)', delFg: '#cf222e',
      hunkBg: 'rgba(9,105,218,0.08)', hunkFg: '#0969da', fileFg: '#57606a',
    };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>
  body{margin:0;background:${theme.bg};color:${theme.fg};font-family:Menlo,monospace;font-size:12px;}
  .head{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid ${theme.border};
    color:${theme.muted};font-size:11px;position:sticky;top:0;background:${theme.bg};}
  .head .a{color:${theme.addFg};}.head .d{color:${theme.delFg};}
  pre{margin:0;padding:4px 0;}
  .line{display:flex;line-height:1.5;}
  .no{flex:0 0 34px;text-align:right;color:${theme.muted};padding-right:6px;user-select:none;}
  .mark{flex:0 0 14px;text-align:center;color:${theme.muted};}
  .code{flex:1;white-space:pre-wrap;word-break:break-all;padding-right:8px;}
  .add{background:${theme.addBg};}.add .code{color:${theme.addFg};}
  .del{background:${theme.delBg};}.del .code{color:${theme.delFg};}
  .hunk .code{color:${theme.hunkFg};background:${theme.hunkBg};}
  .file .code{color:${theme.fileFg};}
  .note{padding:6px 10px;color:${theme.muted};font-size:11px;border-top:1px solid ${theme.border};}
</style></head><body>
<div class="head">${title ? `<span>${escape(title)}</span>` : ''}
<span class="a">+${Number(stats.added) || 0}</span><span class="d">-${Number(stats.removed) || 0}</span></div>
<pre>${rows.join('')}</pre>
${truncatedNote}
</body></html>`;
}
