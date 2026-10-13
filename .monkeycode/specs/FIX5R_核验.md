# FIX-5R 前置核验：任务书里两处与代码不符（已实测）

核验对象：`origin/main 0eed73ca` 的 expo-file-system v19（`node_modules` 实测，非猜测）。

## ① 「用 legacy readAsStringAsync 的 position/length 分片读」——**本版本不可行**

任务书写：「size > 32MB 用 legacy readAsStringAsync 的 position/length 选项 8MB 分片读」。

实测（两处独立证据）：

- **类型声明**（`node_modules/expo-file-system/src/legacy/FileSystem.types.ts:255-262`）：
  > `position` — This option is only used when `encoding: FileSystem.EncodingType.Base64` and `length` is defined.
  > `length` — This option is only used when `encoding: FileSystem.EncodingType.Base64` and `position` is defined.
- **Android 实现**（`.../legacy/FileSystemLegacyModule.kt:182-211`）：
  `if (encoding == EncodingType.BASE64) { ...用 position/length 切片... } else { IOUtils.toString(...) }`
  —— UTF-8 分支**无条件整文件读入**，完全忽略 position/length。

所以「UTF-8 + position/length 分片」拿不到分片：每次调用都会把整个 83MB 再读一遍，
比单发更糟（N 倍内存 + N 倍 IO）。

**替代方案（已核实存在）**：`FileHandle.readBytes(length)`（同步、返回 Uint8Array）
+ `offset` 可写 —— 见 `ExpoFileSystem.types.ts:353-377`，Android 侧实现
`FileSystemFileHandle.kt:24-43`（`RandomAccessFile` 的 `FileChannel`，`write`/`read` 走 position）。
配合本仓库已有先例的增量解码 `decoder.decode(bytes, { stream: true })`
（`src/agent/sdk.js:124` 就这么用）即可真正分片，且**必须在片间用 stream:true**，
否则跨片的多字节 UTF-8 字符会被截断成 U+FFFD。

## ② 「autoBackupRun.js:58 是自动备份的**恢复**路径，埋着同一颗雷」——**定性有误**

`readTextFile` 的实际调用点只有一处：`autoBackupRun.js:122`，在 **SAF 导出**分支里
——把刚落盘的 app 内临时文件读出来、写进用户选的文件夹（导出方向），**不是恢复**。

更关键：**本仓库没有「从自动备份恢复」的入口**。`autoBackups` 只有导出、列目录、
淘汰旧包（`listAppBackups` / `pruneStale`），恢复统一走设置页的手动导入。
所以「自动备份的恢复路径埋着同一颗雷」这句话不成立。

**但它仍然必须一起修**，理由是不同的：SAF 模式的自动备份同样会
`readAsStringAsync` 整读一个 83MB+ 的文件 → 自动备份**在 SAF 模式下会自己失败**
（用户看到的是「自动备份失败」，且同样是被吞掉的 OOM）。
任务书「两个调用点一起换」的**结论对**，理由要改成这条。

## ③ 关于「读取本身炸的内存」的诚实边界

任务书断言 OOM 发生在读取。我**无法在本机证伪**（无设备、无真机堆），但可以指出：
83MB 的 JSON 在 `JSON.parse` 之后会膨胀成 JS 对象图（base64 大字符串 + 数组 + 对象），
通常比原文更占内存。所以「读取」与「解析」**都可能是凶手**，且都以 OOM 收场。

处理方式：不猜。本轮把读取阶段拆成可归因的几步（预检/策略/分片数/耗时）全部写诊断，
并保留上一轮已做的分阶段文案与 `error.message` 透出——真机一次复现就能区分
「读阶段 OOM」与「parse 阶段 OOM」。若日志显示读取成功而 parse 炸，则如任务书所说，
那是二期 NDJSON 流式解析要解决的，本轮不假装解决。

## ④ 真正能省内存的三件事（本轮做，按收益排序）

1. **`planBackupImport` 就地改写**：`sanitizeAndFilterBackupValue` 现在对整棵数据图
   深拷贝（新对象树），峰值直接多一份。payload 是本函数刚 `JSON.parse` 出来的局部对象，
   无共享所有者 → 可就地改，省掉 1×。
2. **`raw` 在 `JSON.parse` 后立即置 null**：否则整段文本与解析结果同时常驻。
3. **诚实上限 + 预检**：超大直接给明确文案，不再「静默读到一半死」（可能就是被吞的 OOM）。

分片读取（FileHandle + 增量解码）也做，但要**如实说明它买到什么**：它避免
「整文件再进一次 Java 堆」并让片间可让出事件循环/可上报进度；由于最终仍要
`JSON.parse(整串)`，它**不能**把峰值降到「与文件大小无关」——那是二期 NDJSON 的事。

---

## 实施结果（本轮）

| 项 | 落点 | 说明 |
|---|---|---|
| 策略决策（纯函数） | `storage/backupRead.js` `decideReadStrategy` | 直读 / 分片 / 超限拒绝；尺寸未知**不拒绝**用户 |
| 分片读 | `backupRead.js` `readChunkedText` | FileHandle + `{stream:true}` 增量解码；片间让出事件循环 |
| 读取编排 | `backupRead.js` `readBackupText` | 预检（exists/size）→ 分派 → 诊断留痕 |
| 调用点 1 | `BackupPanel.js` `handleImport` | 换掉无参数单发整读；`raw` 在 parse 后置 null |
| 调用点 2 | `backup/autoBackupRun.js` `readTextFile` | SAF 导出路径（**不是恢复**，见 ②） |
| 内存瘦身 | `dataBackup.js` `sanitizeAndFilterNode` | `inPlace` 就地改写；导出侧仍走新对象 |
| 诚实上限 | `IMPORT_MAX_BYTES = 512MB` | 导出侧仍是 2GB（见下） |
| 文案 | zh/en `error.js` + `backup.js` | 文件缺失 / 超限（带 MB）/ 读取进度 |

### 一个**刻意保留**的不一致：导出 2GB、导入 512MB

任务书没提，但这是本轮最需要说清的产品决策：

- 导出上限 `BACKUP_MAX_BYTES = 2GB` **不动**：它是流式写，写 2GB 是安全的（已验证）。
- 导入上限 `IMPORT_MAX_BYTES = 512MB`：因为导入仍要 `JSON.parse` 整串，
  峰值与文件大小线性相关，2GB 必然炸。

所以「能导出 2GB 却只能导入 512MB」是有意的诚实上限，不是疏漏。
但**用户会困惑**，因此超限文案必须指出出路（改用快速导出 / 等流式导入），
且这条差异要写进 `AGENTS.md` 的不变量，避免后人「顺手把导入上限也调到 2GB」
——那等于把 OOM 又放回来。二期 NDJSON 做完后两个上限才能真正对齐。

### 测试

`tests/backupReadLargeFile.test.mjs` 29 条：
- 策略矩阵（含边界 `== 上限`、尺寸未知/NaN/null 不误拒）；
- **多字节字符跨片**（汉字 3 字节 / emoji 4 字节 × 多种片长，含 1 字节一片）——
  这是分片读最容易写错、且错了会「静默损坏数据但 JSON.parse 仍成功」的地方；
- EOF 空转、句柄关闭（成功与失败两条路径）、无 FileHandle 不静默降级；
- 就地脱敏与深拷贝**逐字段等价**、确实改写原对象、默认不改写出参。

实现过程中自查修掉 2 个自己写的问题：
1. `decideReadStrategy` 用 `Number(size)` 判断，而 `Number(null) === 0`、`Number('') === 0`
   ⇒「量不出来」被谎报成 `bytes: 0` 写进诊断。改为先判 `null/undefined/''` 再转换。
2. 注释写「片字符串数组 + join」但代码仍是 `text += decode(...)`（Hermes 上会累积
   cons-string 树）。已让代码与注释一致。

