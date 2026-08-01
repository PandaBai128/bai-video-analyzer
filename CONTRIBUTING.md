# Contributing

欢迎提 issue、建议和 PR。

## 适合讨论的问题

- 哪类长视频最需要快速分析和内容导航。
- 分析结果是否准确提炼了内容主线、观点和信息边界。
- 导航切分是否符合视频真实结构。
- 提问回答是否过度总结、证据不足或偏离字幕。
- Markdown 笔记结构是否适合长期沉淀。
- MiniMax 之外的模型或兼容接口是否能正常使用。

## 提交 PR 前

请尽量保持改动聚焦。一个 PR 只解决一个明确问题，避免同时混入大范围重构、文案调整和新功能。

常用检查命令：

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
```

## 不要提交

- API Key、Cookie、Token、私钥。
- 用户笔记、完整字幕、个人观看记录。
- `dist/`、`node_modules/` 或本机系统文件。
