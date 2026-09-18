# 需求文档：角色卡导出

## 简介

角色页支持把角色导出为标准 SillyTavern 角色卡 V2，格式包含 PNG 与 JSON，并调用系统分享面板保存或发送。

## 术语表

- **角色卡 V2**：`spec: chara_card_v2`、`spec_version: 2.0`，字段放在 `data` 中。
- **文本块（tEXt chunk）**：PNG 中存放 base64 卡数据的文本块，关键字为 `chara`。

## 需求

### 需求 1：导出入口

**用户故事：** 作为用户，我希望把角色导出成标准卡，以便备份或分享到其他应用。

#### 验收标准

1. 角色页应提供导出按钮。
2. 当用户点击导出时，系统应生成当前角色的角色卡。
3. 当角色尚未保存时，系统应使用当前已保存内容，并提示先保存编辑。

### 需求 2：字段完整

#### 验收标准

1. 导出的卡应包含 name、description、personality、scenario、first_mes、mes_example、creator_notes、system_prompt、post_history_instructions、tags。
2. 导出的卡应包含世界书 `character_book`。
3. 导出的卡应包含正则扩展 `extensions.regex_scripts`。
4. 导出的卡应同时写入 V2 的 `data` 与 V1 平铺字段，兼容只读 V1 的导入端。

### 需求 3：格式与分享

#### 验收标准

1. 系统应支持导出 PNG 卡，把 base64 卡数据写入 `chara` 文本块。
2. 系统应支持导出 JSON 卡。
3. 当角色存在头像 PNG 时，系统应把卡数据注入该图片。
4. 当角色没有头像时，系统应生成占位 PNG 再注入。
5. 当导出完成时，系统应调用系统分享面板。

## 参考

- `.monkeycode/docs/INDEX.md`