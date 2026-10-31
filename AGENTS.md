# opencode-loop-recover 开发规范

## 推送/发布规则（用户明确要求）

- **git push 和 npm publish 只在用户明确说"推"时才执行**
- 平时所有改动只做本地 commit（不 push）
- 版本号 bump 也只在发布前做

## 开发流程

- `npm test` 全绿才能提交；`npm run build`（tsc → dist/）、`npm run check` 验证插件形态
- 检测器改动必须过真实样本回归（test/fixtures-real-loop.txt）
- `src/detect/` 为 dsh-loop-recover vendored 核心，改动需评估两仓库同步

## 插件形态约束（OpenCode v2）

- server 入口必须 default export `{ id, setup }`（Module schema）
- `ctx.options` 是唯一官方配置通道（opencode.json `plugins[].options`）
- 订阅事件仅 `EventManifest.Server` 公开类型；delta 事件为 ephemeral
- npm 包必须发编译 JS——node_modules 下 `.ts` 会触发 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
- `docs/code/opencode` 为上游参考源码，已在 .gitignore
