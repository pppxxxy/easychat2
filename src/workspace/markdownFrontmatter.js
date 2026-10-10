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
    // allowed-tools：社区 Agent Skills 标准字段（D1）——技能声明建议使用的工具；
    // 只做「让模型可见」的软约束，执行门仍走 registry/riskGate。
    // E3：tools / max-rounds——子代理档案（.easychat/agents/*.md）的字段；
    // 硬边界不在这里（agents.js 会把 tools ∩ 只读白名单），这里只做解析。
    // 下划线写法（部分生成器产出）归一成标准键，消费方只认一种形态。
    if (key === 'name' || key === 'description') out[key] = value;
    else if (key === 'allowed-tools' || key === 'allowed_tools') out['allowed-tools'] = value;
    else if (key === 'tools') out.tools = value;
    else if (key === 'max-rounds' || key === 'max_rounds') out['max-rounds'] = value;
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
