# 图片下载来源 + 白名单（spec 2026-10-21-image-download-sources）

> 用户需求（2026-10-21）：设置 → 功能扩展 → 图片下载里**增加图片来源**，
> 处理白名单，要能自己加；目标是**真的能从这些来源发出图片**。
> 分支 `c1021c1`；测试全量 4698 通过（+13）。

## 现状（先核后做）

- 旧实现：`<download_image:URL>` 通道 + 开关；**没有任何主机白名单**，
  任何 http(s) 图片 URL 都会下载（`chat/attachments.js` 的 `downloadRemoteImage`）。
- 提示词（`prompt/chatPipeline.js`）明确告诉模型「只能在上下文出现过、你确信有效的
  URL 上用」——用户没有「授权来源」的表达方式，模型因此几乎不发图。
- 下载不带任何请求头：**防盗链站点（pixiv 的 i.pximg.net 等）直接 403**——
  这是「加了来源也发不出图」的物理原因。
- 设置页只有一行开关 + 说明，没有名单管理。

## 产品语义（已实现）

1. **名单为空 = 不限制站点**（保持旧行为），但**本机/内网地址一律拒绝**
   （模型给出的 URL 属于被诱导的请求，隐式放行不该包含局域网；SSRF 防线）。
2. **名单非空 = 只允许名单内站点**：精确相等或子域后缀（`i.pximg.net` 命中
   `pximg.net`），与 `plugins/webFetch.js` 的 `isDomainAllowed` 同口径。
3. 每个来源可带**引用页 Referer**：命中来源时随下载请求发送（解决防盗链 403）。
4. 名单写进提示词：模型知道哪些来源被授权；有名单时放宽旧的「只能在上下文
   出现过」限制（仍禁止编造 URL）。
5. 拒绝时气泡给出具体原因（哪个 host 不在名单），不再是笼统「下载失败」。

## 代码落点

| 层 | 文件 | 说明 |
|---|---|---|
| 纯函数 | `src/chat/imageDownloadSources.js` | 主机归一（去协议/路径/端口/账号，拒通配符/纯 IP）、名单归一去重上限 20、匹配、私网判定、请求头（UA + Referer） |
| 存储 | `src/storage/settings/imageDownloadSources.js` | 独立键 `@easychat2_image_download_sources`；损坏时读侧回落空名单、**写侧拒绝覆盖**（同 webFetch 白名单纪律）；增/删/清空串行队列；上限错误带 `IMAGE_SOURCE_LIMIT` |
| 策略编排 | `src/chat/imageDownloadPolicy.js` | 现读名单 → 判定 → 带头下载（从 ChatScreen 外提，避免行数棘轮） |
| 下载 | `src/chat/attachments.js` | `downloadRemoteImage(url, { headers })` → `FileSystem.downloadAsync(..., { headers })` |
| 执行器 | `src/chat/imageDownloadRunner.js` | `DOWNLOAD_IMAGE_BLOCKED` 显示具体拒绝原因，其它失败保持通用文案 |
| 注入 | `src/chat/chatInjections.js` | 开关开启时现读名单，随注入结果带给提示词 |
| 提示词 | `src/prompt/chatPipeline.js` | `buildDownloadImageInstruction(hosts)`：无名单旧严格措辞；有名单列出授权来源 |
| 设置 UI | `src/settings/sections/ExtensionsSection.js` | 「图片来源」折叠区：条数徽章、列表（host + Referer + 删除）、域名/引用页输入、添加按钮、按原因区分错误 |
| 设置接线 | `src/settings/useImageDownloadSources.js` + `src/SettingsScreen.js` | 设置页只调 hook + spread props（行数棘轮） |
| i18n | settings/chat/error 中英各 15+ 条 | 新增词条全部对账 |

## 行数棘轮

按协议先外提（策略 → `imageDownloadPolicy.js`，设置接线 → `useImageDownloadSources.js`），
剩余为最小接线，基线按新实测值同步并记入 `architecture-baseline.json`
`_baselineChangeLog`：SettingsScreen 2365→2371（+6）、useChatSend 1960→1962（+2）、
ChatScreen 3149→3150（+1）。

## 测试

- `tests/imageDownloadSources.test.mjs`（7 组）：归一（粘链接/越界/通配符/纯 IP/私网）、
  引用页校验、名单去重上限、精确/子域/不误匹配、空名单语义与私网拒绝、
  最长后缀与请求头、URL 取主机。
- `tests/imageDownloadSourcesSettings.test.mjs`（5 组）：UI 接线、存储守卫、
  下载链（headers 真进 downloadAsync）、提示词/注入/单聊群聊透传、i18n 成对。
- `tests/chatPipeline.test.mjs` + 回归：有名单/无名单/关闭三种提示词形态。
- `tests/groupChat.test.mjs`：群聊请求新增字段逐字段透传。

## 明确边界（不做）

- **页面→图片提取**：已在后续分支 `c1021c2` 实现（spec 2026-10-21-page-image-extract）：
  直链不是图片时抓 HTML 提取 og:image 等主图；页面主机的授权延伸到其引用的图片
  CDN（私网仍然拒绝）。本条的原始边界说明保留作历史记录。
- **不给模型联网搜图能力**：来源名单是「授权」不是「检索」；提示词仍禁止编造 URL。
- **不接受纯 IP**：名单只收域名（内网 IP 被 SSRF 防线拒绝）。

## 真机验收

1. 设置 → 功能扩展 → 图片下载 → 「图片来源」→ 添加 `i.pximg.net` +
   引用页 `https://www.pixiv.net/`；聊天里发一条包含该站图片直链的消息，
   角色引用链接（或在允许来源下写 `<download_image:…>`）→ 图片应显示。
2. 再发一个其它站点图片链接 → 应出现「图片来源不在允许名单里」的气泡提示。
3. 清空名单 → 任意公网图片链接恢复可下载；`localhost` / `192.168.x` 仍被拒。
