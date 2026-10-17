// GitHub release → 应用内公告的**纯转换层**：归一 release、把 Markdown 正文转成纯文本。
// 零依赖（不引第三方 Markdown 渲染器，按任务书约定），Node 直测。
//
// 安全（SECURITY.md 语义对齐）：release body 是**外部输入**。本模块只做文本化，
// 不产出任何可点击链接、不解析 HTML、不自动打开任何 URL；链接一律降级成「文字 (URL)」，
// 由界面用纯文本展示（首版不渲染可点链接——用户要看就自己去浏览器打开，避免公告成为
// 「点一下就连外网」的注入面）。

// 归一 GitHub release 原始对象 → 公告需要的字段。
// **必须幂等**：本函数的输出会被写进缓存，读缓存时再过一次本函数——
// 若只认 GitHub 原始的 tag_name，缓存往返后 tag 会变空、公告凭空消失。
// 故两种形态都认：原始（tag_name/published_at/html_url）与已归一（tag/publishedAt/url）。
// 取不出 tag 时 version 为空串（上层据此不弹）。
export function normalizeRelease(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tag = String(source.tag_name || source.tag || '').trim();
  return {
    tag,
    version: tag.replace(/^v/i, '').trim(),
    name: String(source.name || '').trim(),
    body: typeof source.body === 'string' ? source.body : '',
    url: String(source.html_url || source.url || '').trim(),
    publishedAt: String(source.published_at || source.publishedAt || '').trim(),
    // 预发布版本默认不当公告（草稿在 API 里本就不可见）。
    prerelease: source.prerelease === true,
    draft: source.draft === true,
  };
}

// 去 Markdown 语法符号，保留可读的行结构。**不做富渲染**：标题/列表符只保留视觉层级。
// 逐行处理，规则尽量少而可预期（宁可留点符号，也不要吃掉正文）。
export function markdownToPlainText(markdown) {
  // 非字符串一律当空（body 是外部输入：数字/对象进来时绝不能渲染出 '[object Object]'）。
  if (typeof markdown !== 'string') return '';
  const source = markdown;
  if (!source.trim()) return '';
  return source
    // 统一换行，避免 \r\n 让后续按行处理错位
    .replace(/\r\n?/g, '\n')
    // 代码块围栏：去掉 ``` 行本身，保留其中的文本（公告里贴命令的场景很常见）
    .split('\n')
    .map(line => line
      // 标题井号：# / ## / ### 前缀去掉（层级靠排版，不留语法符号）
      .replace(/^\s*#{1,6}\s+/, '')
      // 行内代码 `x` → x
      .replace(/`([^`]*)`/g, '$1')
      // 图片 ![alt](url) → alt（不保留 URL：图片是外部资源，公告里没必要展示）
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 链接 [text](url) → text (url)：URL 降级成**纯文字**，不可点击
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => `${text} (${url})`)
      // 粗体/斜体/删除线符号去掉（保留内容）
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      // 引用符：保留缩进语义，去掉 '>'（避免看起来像界面元素）
      .replace(/^\s*>\s?/, '')
      // 无序列表符统一成 '• '（- / * / + 开头）
      .replace(/^\s*[-*+]\s+/, '• ')
      // 水平线整行清掉
      .replace(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/, '')
      .replace(/\s+$/, ''))
    .join('\n')
    // 三个以上连续空行压成一个空行（原始 body 常有此形态）
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
