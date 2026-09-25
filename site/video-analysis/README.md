# bAI 产品首页

`index.html`、`styles.css` 和 `assets/` 是 `https://video-analysis.pandabai.com/` 的静态页面源文件。它们不包含网关后台配置或密钥。页面上的功能截图来自项目 README 所用的实际插件画面。

## 页面设计与动效

- 浅色背景、绿色主色，首屏为标注“功能示意”的可切换演示，功能区使用真实插件截图。
- `styles.css` 管基础与首屏；`assets/sections.css` 管功能、笔记、安装区；`assets/responsive.css` 管响应式与减少动态效果偏好。
- `assets/site.js` 管演示切换、复制按钮与滚动动效。GSAP / ScrollTrigger 3.15.0 随站点托管在 `assets/vendor/`，许可证说明见该目录 `NOTICE.txt`，无需访问外部 CDN。
- 遵循 `prefers-reduced-motion`；移动端展示静态截图，不使用桌面固定预览和鼠标倾斜。禁用 JavaScript 时主要文案、截图、下载与安装说明仍可阅读。
- 更新静态文件时同步调整 HTML 中的资源版本查询参数，避免浏览器沿用旧样式。

## 更新版本时

1. 构建并验证新版 ZIP，确认其中 `dist/manifest.json` 的版本。
2. 更新 `index.html` 中的版本号、固定版本下载文件名、SHA-256 和版本说明；保留 `/latest.zip` 作为稳定下载地址。
3. 使用腾讯云管理工作区的 `scripts/bai-download/build_release.py` 生成静态 release。脚本会检查页面版本、ZIP manifest 与校验值是否一致，并生成 `latest.json`。
4. 按腾讯云管理工作区的 `scripts/bai-download/README.md` 发布到新的服务器 release，原子切换 `current`，验证首页、ZIP 哈希和原有 API 路径。

开发者模式加载 ZIP 的 Chrome 用户需要手动覆盖原安装目录并重新加载扩展。`latest.json` 只提供版本信息，目前不触发浏览器自动安装。
