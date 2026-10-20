# 页面 → 主图提取（og:image）spec 2026-10-21-page-image-extract

> 用户需求（2026-10-21）：「丢一个图片站首页/作品页，它自己找出图并发送」。
> 上一轮（c1021c1）只解决了直链 + 来源白名单；本轮补「页面兜底」：
> 直链不是图片时，抓 HTML 提取 og:image 等主图候选再下载。
> 分支 `c1021c2`；全量 4711 通过（+13）。

## 流程（已实现）

```
<download_image:URL>
  → 页面主机按「图片来源」名单校验（空名单=不限制，但拒私网）
  → 先当直链下载（原通道，带 UA/Referer）
      成功 → 完成
      失败且 code=DOWNLOAD_IMAGE_NOT_IMAGE
        → 抓页面 HTML（15s 超时、2MB 上限、重定向私网复核）
        → 提取主图候选（og:image:secure_url → og:image → og:image:url →
          twitter:image → twitter:image:src → itemprop=image →
          link[rel=image_src] → 无声明时才用 <img>，限 5 个）
        → 逐个尝试下载（最多 2 个候选；候选主机拒绝本机/内网）
        → 全部失败：抛回「不是图片」→ 聊天里显示通用下载失败
```

## 关键设计（防跑偏）

1. **图片 CDN 继承页面授权**：用户授权的是「这个站点」，图片常来自其 CDN
   （pixiv 页面 → `i.pximg.net`）。要求用户再配一遍 CDN 不现实，因此候选图片
   主机**不需要**在名单内——但**永远拒绝私网**（页面 HTML 不可信，可能是 SSRF 跳板）。
2. **候选 Referer**：命中了来源条目 → 用该条目配置的引用页；没命中 → 用
   **页面最终 URL**（防盗链最常见的一档，pixiv 的 i.pximg.net 就吃这个）。
3. **私网判定复用 webFetch 的加固实现**（十进制/八进制/十六进制 IPv4、
   IPv4-mapped IPv6 都能识别）；`chat/imageDownloadSources.js` 不再维护简化正则
   （旧实现会漏掉 `http://2130706433/` 这类回环地址）。
4. **页面抓取复用 webFetch 骨架**：`normalizeFetchUrl`（fail-closed 拒私网）+
   `isPrivateRedirectTarget`（重定向到内网丢弃响应）+ `vendorXhr`（超时/错误骨架）；
   **不走** web_fetch 的未知域名弹窗授权——图片下载的授权口径是设置里的来源名单，
   页面主机在进入抓取前已校验。
5. **只认 og/twitter 声明式主图**：没有 JS 渲染与真实布局，「找最大图」不可信；
   `<img>` 兜底只在页面完全没有声明主图时启用，否则正文装饰图会抢在 og:image 前面。
6. **不做站点 API 检索**：各站私有 API 鉴权/频控/合规成本高；og:image 覆盖绝大多数
   作品页/文章页/图集页的公开主图。

## 代码落点

| 层 | 文件 | 说明 |
|---|---|---|
| 纯提取 | `src/chat/pageImageExtract.js` | `resolveResourceUrl`（绝对/协议相对/根相对/相对/查询；拒 data:/javascript:）、`extractPageImageCandidates`（优先级+去重+上限）、`looksLikeImageUrl` |
| 页面抓取 | `src/chat/pageImageFetch.js` | `fetchPageHtml`：webFetch 安全骨架 + 15s 超时 + 2MB 上限 + 最终 URL 回传 |
| 编排 | `src/chat/pageImageDownload.js` | `downloadImageOrPage`：直链优先 → 页面兜底 → 候选逐个试（≤2）；依赖注入（Node 直测） |
| 装配 | `src/chat/imageDownloadPolicy.js` | 读名单 + 注入真实下载器/抓取器 |
| 私网加固 | `src/chat/imageDownloadSources.js` | `isPrivateDownloadHost` 改为委托 webFetch 的 `isPrivateHost` |
| 提示词 | `src/prompt/chatPipeline.js` | 明确「也支持页面地址（作品页/文章页/图集页），系统会自动找主图」 |
| 设置文案 | settings zh/en | 图片下载说明与来源说明补「页面地址也可以」 |

## 测试（+13）

- `tests/pageImageExtract.test.mjs`（7）：URL 解析、扩展名判定、优先级、属性顺序/
  单引号/大写标签/实体解码、img 兜底与上限、去重与坏输入。
- `tests/pageImageDownload.test.mjs`（7）：直链成功、页面兜底（CDN 继承授权 +
  页面 Referer）、命中来源用配置 Referer、页面主机不在名单拒绝、私网（含十进制
  IPv4）拒绝、私网候选跳过与候选上限、抓取失败/未注入/其它错误的透传。
- 既有测试更新：设置接线断言改为「编排层 + 页面抓取」链路；提示词补页面地址断言。

## 边界（如实登记）

- **纯 JS 渲染且无 og/twitter 声明的页面**提取不到主图（无浏览器执行环境）；
- 候选最多尝试 2 个（避免单条指令拖 15s×N）；
- 页面抓取失败不暴露具体原因（聊天里仍是通用「图片下载失败」）；
- 不做站点 API 检索 / OCR / 视频封面。

## 真机验收

1. 设置 → 功能扩展 → 图片下载 → 来源加 `www.pixiv.net`，引用页 `https://www.pixiv.net/`；
2. 聊天里发一个 pixiv 作品页链接给角色，角色用 `<download_image:作品页URL>` →
   图片应出现（日志路径：直链失败 → 抓页面 → og:image → i.pximg.net 带 Referer 下载）；
3. 发一个不在名单里的站点页面 → 应提示「图片来源不在允许名单里」；
4. 发一个没有 og:image 的纯 JS 页面 → 显示通用下载失败（已知边界）。
