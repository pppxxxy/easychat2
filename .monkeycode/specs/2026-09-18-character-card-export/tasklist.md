# 需求实施计划

- [x] 1. 依赖与卡数据构造
  - [x] 1.1 安装 `expo-sharing` 并确认与 Expo SDK 50 版本匹配（设计「组件与接口」）
  - [x] 1.2 新建 `src/cardExporter.js`，实现 `buildCardV2(character)`：同时写入 V2 `data` 与 V1 平铺字段，映射 `character_book` 与 `extensions.regex_scripts`（需求 2.1、2.2、2.3、2.4；设计「数据模型」）
  - [x] 1.3 实现 `cardToJson(character)`：返回格式化 JSON 字符串（需求 3.2）
  - [ ]* 1.4 Node 脚本：`buildCardV2` 往返字段一致、世界书与正则映射正确（设计「测试策略」）

- [x] 2. PNG 编码与文件导出
  - [x] 2.1 在 `src/cardExporter.js` 实现 PNG 块工具：CRC32、Adler32、`tEXt` 块构造与字节拼接（设计「PNG 编码」）
  - [x] 2.2 实现 `createPlaceholderPng()`：生成含完整卡数据的最小 RGB PNG，使用 deflate stored 块（需求 3.4；设计「PNG 编码」）
  - [x] 2.3 实现 `injectCharaChunk(pngBytes, jsonText)`：在 `IHDR` 之后、`IDAT` 之前插入 `chara` 文本块；头像读取失败时回退占位 PNG（需求 3.1、3.3；设计「错误处理」）
  - [x] 2.4 实现 `cardToPng(character, avatarBytes)` 与 `exportCardFile(character, format, avatarBytes)`：写入缓存目录并返回文件 uri（需求 3.5；设计「组件与接口」）
  - [ ]* 2.5 Node 脚本：解析生成的 PNG 校验块结构与 CRC，`chara` base64 可解码为合法 JSON（设计「正确性属性」2、3）

- [x] 3. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [x] 4. CharacterScreen 导出入口
  - [x] 4.1 在角色页新增导出按钮，点击弹出 PNG / JSON 格式选择（需求 1.1、1.2）
  - [x] 4.2 读取当前角色头像字节并调用导出，完成后经 `Sharing.shareAsync` 调用系统分享面板（需求 3.3、3.5）
  - [x] 4.3 未保存编辑时提示先保存；PNG 失败回退 JSON；分享不可用时提示文件路径（需求 1.3；设计「错误处理」）
  - [ ]* 4.4 脚本：入口回调、格式选择与回退分支（设计「测试策略」）

- [x] 5. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [x] 6. 回归验证
  - [x] 6.1 运行 `npm ci` 验证依赖与锁文件一致（设计「测试策略」）
  - [x] 6.2 运行 `npx expo export --platform android` 验证打包成功（设计「测试策略」）
  - [x] 6.3 同步 `.monkeycode/docs/` 中角色卡与角色页相关章节（需求 1、2、3）