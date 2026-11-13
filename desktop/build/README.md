# 桌面应用图标（ICO）
#
# 由仓库根 `assets/icon.png`（1024×1024 调色板 PNG）经 ffmpeg 转换而来：
#   ffmpeg -y -i ../assets/icon.png -vf "scale=256:256:flags=lanczos" -frames:v 1 icon.ico
#
# 为什么必须预转：electron-builder 24 与 NSIS 的图标加载器都**只接受 32 位 RGBA**，
# 直接指向调色板 PNG 会以 `invalid icon file` 失败（踩过两次）。这一步是构建期
# 一次性工作，产物入库，避免每次 CI 依赖 ffmpeg 与本机字体/图像库差异。
# 换图标时：改根 assets/icon.png 后重跑上面的命令覆盖本文件。