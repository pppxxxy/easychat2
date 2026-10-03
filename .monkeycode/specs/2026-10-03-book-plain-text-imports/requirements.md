# Requirements Document — 本地书籍纯文本导入（多格式 + 多编码）

## Introduction

在现有「UTF-8 纯文本（.txt/.md）」导入基础上，扩展本地书籍导入能力：从 Word（.docx）等常见文档中提取纯文本，并自动识别常见字符编码（UTF-8/UTF-16/GBK/GB18030/BIG5 等），消除导入乱码。现有导入失败提示「文件不是 UTF-8 编码」（见现状截图）即本需求要解决的核心痛点。

## Glossary

- **书籍文件**：导入后落盘于 `documentDirectory/books/<id>.txt`、恒以 UTF-8 编码保存的纯文本正文。
- **纯文本提取**：从文档容器（ZIP/XML/HTML 等）中抽取阅读用文字、丢弃排版标记的过程。
- **编码探测**：依据 BOM 与字节统计特征推断源文件字符集的过程。
- **替换符**：解码非本编码文本时产生的 U+FFFD 字符；其占比是解码是否正确的判据。
- **受支持的输入格式**：`.txt`、`.md`、`.markdown`、`.docx`、`.html`、`.htm`。

## Requirements

### Requirement 1 — 多格式导入

**User Story:** AS 阅读用户, I want 导入多种纯文本/文档格式, so that 我不必先把文件手动转成 txt。

#### Acceptance Criteria

1. WHEN 用户选择的文件名匹配受支持的输入格式, the app SHALL 按格式提取纯文本（`.txt/.md/.markdown` 直接读取；`.docx` 解压 `word/document.xml` 并剥离标签；`.html/.htm` 剥离标签与脚本样式）。
2. WHEN 用户选择的文件扩展名不在受支持列表内, the app SHALL 以错误码 `UNSUPPORTED_FORMAT` 提示当前支持的格式清单。
3. WHEN `.docx` 文件不包含 `word/document.xml`, the app SHALL 以错误码 `UNSUPPORTED_FORMAT` 提示该文档无法提取正文。

### Requirement 2 — 编码识别与解码

**User Story:** AS 阅读用户, I want 应用自动识别文件编码, so that 下载的 GBK 小说不再显示为乱码。

#### Acceptance Criteria

1. WHEN 文件以 UTF-8 BOM 或 UTF-16 BOM 开头, the app SHALL 依据 BOM 选择 UTF-8 / UTF-16LE / UTF-16BE 解码。
2. WHEN 文件无 BOM, the app SHALL 通过探测在 UTF-8、GB18030、BIG5 之间选择解码方式。
3. IF 首选解码结果的替换符占比超过阈值, the app SHALL 依次尝试备选编码并选取替换符占比最低的解码结果。
4. WHEN 全部候选解码结果的替换符占比均超过阈值, the app SHALL 以错误码 `ENCODING` 提示「无法识别文件编码」，并导出（或提示）可执行的替代操作。
5. WHEN 解码成功, the app SHALL 在书籍元数据中记录原始文件名与探测到的编码标识，供后续排查。

### Requirement 3 — 落盘与元数据

**User Story:** AS 阅读用户, I want 导入结果稳定可续读, so that 关闭应用后再次打开能继续阅读。

#### Acceptance Criteria

1. WHEN 纯文本提取与解码成功, the app SHALL 将正文以 UTF-8 写入 `books/<id>.txt` 并通过 `saveBookItem` 落库（name/uri/size/chars/addedAt/chapters）。
2. WHEN 导入的源格式为 `.docx` 或 `.html`, the app SHALL 以提取后的纯文本字符数作为 `chars`。
3. WHILE 正文分块结果与既有 `splitBookIntoBlocks` 约定一致, the app SHALL 复用现有分块与分页逻辑，且阅读进度语义不变。

### Requirement 4 — 失败清理与不回归

**User Story:** AS 维护者, I want 导入失败不留残留、旧行为不变, so that 存储与既有用户不受影响。

#### Acceptance Criteria

1. IF 复制、提取、解码、落库任一步骤失败, the app SHALL 删除本次产生的半成品文件且不写入书籍索引。
2. WHEN 导入 `.txt/.md/.markdown` 且编码为 UTF-8, the app SHALL 保持与现状一致的行为（`UNSUPPORTED_FORMAT`/`ENCODING` 错误码语义、清理策略）。
3. WHEN 用户取消文件选择, the app SHALL 返回 `{ canceled: true }` 且不产生任何副作用。

## 决策（2026-10-03 已定）

- **格式范围**：`.txt / .md / .markdown / .docx / .html / .htm`。**EPUB 不做**（解压 + spine 抽取复杂度高，本次不纳入）。
- **编码支持**：先做技术选型 spike，选用 RN/Hermes 可用的**纯 JS** 探测 + 解码方案；若无可接受方案，则退化为「自动探测 + 明确指引用户另存为 UTF-8」，不引入高风险原生依赖。
- **`.docx` 提取**：复用已有 `fflate`（`unzipSync`）解压后用纯字符串处理 `word/document.xml`，不新增解压依赖。
