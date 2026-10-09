// Markdown frontmatter 解析（工作区技能 SKILL.md 与斜杠命令 *.md 共用）。
//
// 只认单行 `key: value`（当前需要 name / description 两个键），不做完整 YAML——
// 依赖越少越可测；附件型字段将来真要再加。
//
// 边界：
// - 未闭合的 `---` 当普通正文（不能把整份文件吞掉）；
// - 只剥离开头紧邻的块（`---\n ... \n---`），正文中间的 --- 是分割线不是元数据。

function parseLines(block) {
  const out = {};
  for (const line of String(block || '').split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    // 去包裹引号（单/双），其余原样。
    const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (!value) continue;
    if (key === 'name' || key === 'description') out[key] = value;
  }
  return out;
}

// 输入全文 → { meta: { name?, description? }, body }（body 已去掉 frontmatter 块）。
export function splitMarkdownFrontmatter(text) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const head = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!head) return { meta: {}, body: raw };
  return { meta: parseLines(head[1]), body: raw.slice(head[0].length) };
}
