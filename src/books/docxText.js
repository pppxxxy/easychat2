// DOCX 文本提取（纯函数，零依赖）：zip 解包后从 word/document.xml 里取正文。
//
// 为什么放在共享层：手机端也有 .docx 导入（走原生/第三方库），桌面需要自己实现。
// 把「从 XML 里抽段落」这段纯逻辑放这里，就能在 Node 里直接测，不必真起 Electron。
// zip 解包本身需要 zlib（Node 内置、渲染进程没有），所以解包在主进程做，
// 解出来的 XML 交给本模块解析——两边职责清晰：主进程管字节，本模块管文本。
//
// 只做「读文本」，不做样式：导入书库要的是正文与章节标题，段落边界保留为换行，
// 制表符转空格，其余标记全部丢弃。这不是完整的 OOXML 实现，也不需要是。

// 从 XML 里取 <w:t> 文本节点，按段落（<w:p>）聚合。
// 换行规则：每个 <w:p> 输出一行；<w:br/> 与 <w:tab/> 分别转成换行与空格。
export function extractDocxText(xml) {
  const source = String(xml == null ? '' : xml);
  if (!source) return '';

  // 先把段落切开，再在段内抽文本——顺序反了会把跨段落的文本连成一行。
  const paragraphs = source.split(/<w:p[ >]/);
  const lines = [];

  for (const raw of paragraphs) {
    if (!raw) continue;
    let text = '';

    // 段内逐 token 扫描：<w:t>…</w:t> 取文本，<w:br/> 换行，<w:tab/> 空格。
    // 用一次正则扫描而不是多次 replace，避免「先替换标签再取文本」时把
    // 属性里的尖括号当内容（document.xml 的属性值里确实会出现 &lt; 之类）。
    const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g;
    let match;
    while ((match = tokenRe.exec(raw)) !== null) {
      if (match[1] !== undefined) {
        text += decodeXmlEntities(match[1]);
      } else if (match[0].startsWith('<w:br')) {
        text += '\n';
      } else {
        text += ' ';
      }
    }

    if (text.trim()) lines.push(text);
  }

  // 段间用单个换行：导入书库后按「第X章」/标题切块时，段落是自然的行边界。
  return lines.join('\n');
}

// XML 实体解码：只处理文档里会出现的五个 + 数字实体。
// 不做 HTML 实体全表——docx 里不会出现 &nbsp; 之类。
export function decodeXmlEntities(value) {
  return String(value == null ? '' : value).replace(
    /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (whole, entity) => {
      switch (entity) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: break;
      }
      const numeric = entity[0] === '#'
        ? (entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10))
        : NaN;
      if (!Number.isFinite(numeric) || numeric <= 0) return whole;
      try {
        return String.fromCodePoint(numeric);
      } catch (error) {
        return whole;
      }
    }
  );
}

// zip 里定位目标条目：DOCX 的正文固定是 word/document.xml。
// 返回 { name, offset, compressedSize, method } 或 null。
// 只读中央目录（End of Central Directory）之前的部分即可定位本地头，
// 这里用最直接的本地文件头扫描：DOCX 由 Word 生成，条目顺序稳定。
export const DOCX_DOCUMENT_ENTRY = 'word/document.xml';
