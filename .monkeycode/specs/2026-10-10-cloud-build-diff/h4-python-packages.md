# H4 评估报告：Python 包白名单扩充（BUNDLED_PACKAGES）

> **状态：报告就绪，未动代码**（等用户按表裁决）。铁律：**不做运行时 pip**——
> 包只能构建期打进 APK（2026-10-08 已裁决）；扩充的唯一口径是 python.js 与
> withChaquopy.js 的 **BUNDLED_PACKAGES 双清单同步**（已有漂移测试守着）。

## 候选包与估算（**数字必须构建实测后以实测为准**）

| 包 | 用途 | APK 增量估算 | 依赖连带 | 建议 |
|---|---|---|---|---|
| openpyxl | Excel 读写（与工作区 docx 导出同族的办公自动化） | +3~6MB | 无 | **优先**（小、场景明确） |
| reportlab | PDF 生成 | +6~10MB | 无 | **优先**（与 docx 导出互补） |
| numpy | 数值计算（几乎一切数据处理的底座） | +12~20MB | 无 | 中（收益大但增量也大） |
| pandas | 表格/时间序列（数据处理主力） | +25~40MB | numpy + dateutil + pytz | 中（**必须与 numpy 一起加**） |
| matplotlib | 画图（生成图表图片） | +15~25MB | numpy | 低（价值高但增量最大） |
| requests | 联网请求 | 已含（现状） | — | — |

**组合参考**：openpyxl + reportlab ≈ +10~16MB（推荐先加这组）；
+numpy+pandas ≈ +50~80MB 总计（按手机存储余量决策）。

## 测量方法（构建实测步骤，拿到真数字再拍板）

1. 在 `python.js` / `withChaquopy.js` 的 BUNDLED_PACKAGES 各加目标包（双清单同步）；
2. 本地构建 release APK（或 CI 构建，走 H1 的云构建也行——但 Chaquopy 构建需要
   本地 Android SDK，CI 侧要配）；
3. 记录 APK 体积差 =「之后」−「之前」（同一构建配置）；
4. 真机冒烟：`import <包>` + 一个最小用例（openpyxl 写一行 → 文件落工作区）；
5. 回填本表「实测增量」列，交付用户裁决（加哪些、加几个）。

## 注意事项

- **构建时间**：Chaquopy 每加一个原生依赖包，构建时间线性上升（numpy/pandas 是
  编译型 wheel，首次构建可能多几分钟到十几分钟）。
- **ABI 过滤**：Chaquopy 的 `abiFilters` 决定打进哪些架构（现状配置需复核——
  只打 arm64-v8a 能省近一半体积，若用户机型可覆盖则优先）。
- **无运行时 pip 的边界**：用户想装表外的包只能：① 改白名单重新构建；
  ② 用 shell/py 纯标准库实现；③ 走云（H1 的 Actions 或用 API 侧模型联网）——
  这三条已足够覆盖「偶尔要用」的长尾，不值得为长尾引入运行时包管理。
