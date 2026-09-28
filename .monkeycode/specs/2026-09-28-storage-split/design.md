# storage.js 拆分技术方案

Feature Name: storage-split
Updated: 2026-09-28
状态: 进行中（已完成 `io`、`worldMap`、`diary`、`moments`、`stickers`、`settings`、`apiConfigs`、`personas`、`globalPresets`、`vector`（`reconcileVectorIndexes` 待并入）、`affinity`）

## 实施记录

- 2026-09-28 阶段 0 完成：新建 `src/storage/io.js`（`readJson`/`setJsonWithSecrets`/`readJsonWithSecrets`/`readJsonStatusWithSecrets`/`getSqliteModule`/`readLargeAsyncStorageValue`/`readJsonStatus`/`backupCorruptValue`/`CORRUPT_BACKUP_SUFFIX`）；`storage.js` 改为 import 且删除本地定义（不再直接 import `secretStore`/`diagnostics`）。`tests/characterStorage.test.mjs`、`tests/proactiveSettings.test.mjs` 增加「`Module._load` 拦截 `src/storage/*`，按需 Babel 转 CJS」的加载器。核验：lint 无输出、446/446、覆盖率 ≥40%、Metro 打包成功。`storage.js` 3771 → 3662 行。
- 2026-09-28 阶段 1 完成：新建 `src/storage/worldMap.js`（`WORLD_MAP_KEY` + `enqueueWorldMapMutation` + `getWorldMapStatus`/`getWorldMap`/`updateWorldMap`/`detachCharacterFromWorldMap`）；`storage.js` 删除实现、改为 import + re-export（`detachCharacterFromWorldMap` 仍被角色删除逻辑内部调用）。`tests/worldMap.test.mjs` 源码断言改读 `storage/worldMap.js`（角色删除联动那句仍断言 barrel）。核验同上。`storage.js` 3662 → 3623 行。
- 2026-09-28 阶段 2 完成：新建 `src/storage/diary.js`（`DIARY_*` 键 + `enqueueDiaryMutation` + 日记设置/索引/条目读写与按角色删除）；`storage.js` 删除实现、re-export（内部仍用 `getDiarySettings`/`saveDiarySettings`/`deleteDiariesForCharacterDeletion`；`removeRolesFromDiarySettings` 留在 barrel 的角色删除逻辑）。`tests/diary.test.mjs` 源码断言改读 `storage/diary.js`。核验同上。`storage.js` 3623 → 3506 行。
- 2026-09-28 阶段 3 完成：新建 `src/storage/moments.js`（`MOMENTS_SETTINGS_KEY`/`PROACTIVE_SETTINGS_KEY`/`MOMENTS_KEY` + `enqueueMomentsMutation` + 动态设置/集合读写 + 互动（`PROACTIVE_MODES`/`makeProactiveSlotId`/设置）+ 按会话/角色删除联动）。`storage.js` 删除实现并 re-export；为内部媒体清理保留 `MOMENTS_KEY`（`isAvatarReferenceBackupKey`）与 `getMomentsStatus`（`collectAvatarImageFiles`）的 import。核验同上。`storage.js` 3506 → 3331 行。
- 2026-09-28 阶段 4 完成：新建 `src/storage/stickers.js`（`@easychat2_sticker_*` 键 + `stickerWriteQueue` + 索引/条目读写、旧整表迁移、`getStickers`/`saveSticker`/`readStickerStatus`/`isStickerReferenceBackupKey`）。`storage.js` 删除实现并 re-export；媒体清理 `collectStickerImageFiles` 仍留在 barrel，import `readStickerStatus`/`isStickerReferenceBackupKey`。核验同上。`storage.js` 3331 → 3169 行。
- 2026-09-28 阶段 5 完成：新建 `src/storage/settings.js`（思考 / 采样 / 图像生成 / 聊天选项 / 外观 / 配图 / 语音播报 / 记忆总结 / 插件 / 免责声明与引导；含各自 normalizer 与默认值）。`storage.js` 删除实现并 re-export；移除不再用的 `isKnownImageProvider`/`normalizeImagePosition` import 与 11 个键常量。`tests/aigc.test.mjs` 的 `DISCLAIMER_VERSION` 源码断言改读 `storage/settings.js`。核验同上。`storage.js` 3169 → 2785 行。
- 2026-09-28 阶段 6 完成：新建 `src/storage/apiConfigs.js`（API 配置 + `getActiveModel` + `DEFAULT_API_CONFIG`，含密钥走 `*WithSecrets`）、`src/storage/personas.js`（人设 + 用户全局资料；导出 `USER_PROFILE_KEY` 供媒体清理判断备份键）、`src/storage/globalPresets.js`（全局预设列表与开关）。`storage.js` 删除实现并 re-export；为媒体清理 import `USER_PROFILE_KEY`/`getUserProfileStatus`；移除不再用的 `GLOBAL_PRESETS` 与 `readJsonStatusWithSecrets` import。核验同上。`storage.js` 2785 → 2361 行。
- 2026-09-28 阶段 7 完成：新建 `src/storage/vector.js`（多配置载荷 + 按角色向量索引 CRUD + `clearVectorIndex`）。**例外**：`reconcileVectorIndexes` 依赖会话列表读取（`readSessionsStatus`，仍属会话领域），本次暂留 `storage.js` barrel；为此 vector.js 导出 `readVectorIndexStatus`/`VECTOR_INDEX_PREFIX` 供其使用，待 sessions 领域抽出后再并入。`storage.js` 删除实现并 re-export；内部 import `clearVectorIndex`（角色删除）、`removeVectorIndexForSession(s)`（会话删除）、`readVectorIndexStatus`/`updateVectorIndex`/`VECTOR_INDEX_PREFIX`（reconcile）；移除不再用的 `readJsonWithSecrets`/`setJsonWithSecrets` import。核验同上。`storage.js` 2361 → 2165 行。
- 2026-09-29 阶段 8 完成：新建 `src/storage/affinity.js`（好感度 `@easychat2_affinity` + `getAffinityStatus`/`saveAffinity` + `normalizeAffinityState`）。`storage.js` 删除实现并 re-export；移除 `AFFINITY_KEY`。核验同上。`storage.js` 2165 → 2133 行。

## 工程加固（2026-09-29，独立于拆分）

- 已提交 `0947889`：覆盖率地板 40 → 60（`.c8rc.json`）、`eslint` 精确锁 `10.11.0` + `engines.node`、新增 `eslint-plugin-react@7.37.5` 并启用 `react/jsx-uses-vars`（消除对 ESLint 10 core JSX 追踪的隐性依赖）。
- 待办 P1：审计 `.c8rc.json` exclude 清单（当前约 62% src 行被排除）与 hooks 纯逻辑外提补测；`secretStore` 在 protect/hydrate 命中 `SECRET_FIELDS` 明文时登记 `registerSecretValues`（脱敏双保险）。
- 待办 P2：消除 `MODULE_TYPELESS_PACKAGE_JSON`（先 spike `src/package.json` type:module）；统一相对导入 `.js` 扩展名（356 处）。
- 待办 P3：聊天主链路真机冒烟清单。

## 目标

`src/storage.js` 当前 3771 行，是全仓第二大文件、也是唯一的持久化中枢。目标是在**不改变任何行为、不改变对外 API**的前提下按领域拆分：

- `src/storage.js` 保留为**对外的 barrel**（继续 `export` 全部既有函数/常量），所有既有导入方（`App.js`、各 Screen/Panel、`api.js` 等）**零改动**。
- 各领域模块放 `src/storage/<domain>.js`，`storage.js` 从它们 re-export。
- 共享的 AsyncStorage/FileSystem I/O 原语、含密钥读写包装、损坏备份、SQLite 大值读取先抽到 `src/storage/io.js`，供各领域复用。

## 关键约束（动手前必读）

1. **对外导出必须保持不变**：任何 PR 都不允许让既有导入方改路径。barrel 负责 re-export。
2. **测试用「把 storage.js 转 CJS 再 `Module._compile`」的方式打桩**：`tests/characterStorage.test.mjs`、`tests/proactiveSettings.test.mjs` 用 Babel 把 `src/storage.js` 转成 CommonJS 后 `_compile`，靠 `Module._load` 补丁 mock `@react-native-async-storage/async-storage` / `expo-file-system` / `expo-sqlite`。
   - **坑**：`storage.js` 若 `import` 拆出的新模块（ESM），Node 会走 `require(esm)`，其内部 import 由 **ESM 解析器**处理，**绕过 `Module._load` 补丁** → mock 失效、测试崩（真实 `expo-file-system` 解析失败）。
   - **对策**：在两个编译型测试里，预先用同一 Babel 配置把新模块转成 CJS，构造 `Module` 并写入 `Module._cache[<绝对路径>]`，再加载 `storage.js`；这样 `require('./storage/xxx.js')` 命中 CJS 缓存，其内部依赖仍走 `Module._load` 补丁。新增拆出的模块时，测试需同步登记。
3. **源码断言测试**：`tests/diary.test.mjs`、`tests/worldMap.test.mjs` 直接读取 `src/storage.js` 源码断言含某些键名/函数名。把对应领域搬出后，这些断言须改指向新模块（与 ChatScreen 拆分时改 `richHtml`/`aigc` 断言同理）。
4. **队列与竞态**：`sessionMutationQueue`/`momentsMutationQueue`/`diaryMutationQueue`/`worldMapWriteQueue`/`stickerWriteQueue`/`cardForgeWriteQueue`、`deletedSessionIds`、`sessionSummaryRevisions`、`vectorIndexWriteQueues`、`protectedChatImageUris` 等模块级可变状态随其领域一起搬，语义逐字保留。
5. **存储键与迁移分支**：`@easychat2_messages::<sessionId>`、`CHARACTER_INDEX_KEY`/`CHARACTER_ITEM_PREFIX`、旧键迁移（`@easychat2_characters`、`@easychat2_character`、`@easychat2_messages`、`@easychat2_stickers`、`@easychat2_api_config`）等必须逐字保留；索引最后写、损坏先备份等提交语义不变。

## 拆分阶段（每步独立提交、独立可回滚）

### 阶段 0：共享 I/O 层（已完成）

新建 `src/storage/io.js`，搬入 `readJson`/`setJsonWithSecrets`/`readJsonWithSecrets`/`readJsonStatusWithSecrets`/`getSqliteModule`/`readLargeAsyncStorageValue`/`readJsonStatus`/`backupCorruptValue`/`CORRUPT_BACKUP_SUFFIX`；`storage.js` 改为 import。同步改两个编译型测试注册该模块。核验：lint 无输出、446/446、覆盖率 ≥40%、Metro 打包成功。

### 阶段 1..N：按领域外提（待做）

建议顺序（由依赖少到多）：

1. `worldMap.js`（`@easychat2_world_map` + `enqueueWorldMapMutation`）——**已完成**
2. `diary.js`（`@easychat2_diary_*` + `enqueueDiaryMutation`）——**已完成**
3. `moments.js`（**含 设置 + 集合 + 按角色/会话删除**：`MOMENTS_SETTINGS_KEY`/`MOMENTS_KEY`/`PROACTIVE_SETTINGS_KEY` + `enqueueMomentsMutation`）——**已完成**
4. `stickers.js`（`@easychat2_sticker_*` + `stickerWriteQueue` + 表情包文件收集）——**已完成**（文件收集仍留在 barrel 的媒体清理）
5. `settings.js`（thinking/sampling/imageGen/chatOptions/appearance/inlineImage/tts/memorySummary/plugins/disclaimer/onboarding）——**已完成**
6. `apiConfigs.js` / `personas.js` / `userProfile.js` / `globalPresets.js`（含密钥读写，走 `io.js` 的 `*WithSecrets`）——**已完成**（userProfile 并入 `personas.js`）
7. `vector.js`（vector memory config/index + `vectorIndexWriteQueues`）——**已完成**（`reconcileVectorIndexes` 待 sessions 抽出后并入）
8. `affinity.js`——**已完成**
9. `cardForge.js`（含 payload 文件写入）
10. `characters.js`（角色库索引+条目文件、迁移、默认角色、`characterLibraryWriteBlocked`）
11. `sessions.js`（sessions + messages + summaries + searchMessages + 迁移 + `enqueueSessionMutation` + 图片文件收集）——最大、最后做

每步：纯搬运、逐字保留语义；更新受影响的源码断言测试；跑 lint + `npm test` + `test:coverage` + Metro；单独提交。

## 验证基线

```bash
npm run lint
npm test
npm run test:coverage
npx expo export --platform android
```

## 明确不做

- 不改任何对外导出名/签名，不改存储键，不改迁移与提交语义。
- 不「顺手优化」队列、重试与损坏处理。
- barrel `storage.js` 不重命名、不移动位置。