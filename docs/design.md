# opencode-loop-recover 开发文档

> 模型死循环防护插件——OpenCode 版。检测流内重复输出 → 切断 → 清洗中毒上下文 → 原地续跑。
> 移植自 [dsh-loop-recover](https://github.com/terry2010/dsh-loop-recover)（DeepSeek Harness 插件）。
> 所有 API 结论均已对照 `docs/code/opencode`（sst/opencode dev 分支）源码验证。

## 1. 项目定位

本地/小参数模型（Ornith、Qwen 小模型等）在长任务中容易进入两类病理循环：

- **字面坍缩**：`ssssss...`、字符级无限重复
- **语义/工具循环**：reasoning 反复复读同一段分析、重复发起同样的工具查询

已有方案（TokenEconomizer loopguard、opencode 各类 /loop 编排器）都是**工具调用后**的
失败循环检测或任务编排，没有人做**流内重复检测 + 上下文手术 + 自动续跑**。

调研结论：OpenCode **v2 插件 API 可完整实现全部功能**，多个环节比 DSH 更强。

## 2. 功能范围（与 dsh 版对齐）

| 功能 | 说明 |
|---|---|
| 五层检测器 | periodic、n-gram、anchor、char-run、sentence-pool |
| 意图级检测 | 工具调用签名追踪，识别语义重复的搜索/查询 |
| 三种模式 | `rescue`（切断+清洗+续跑）、`cut`（只切断）、`observe`（只记录） |
| 流内观测 | 订阅 `session.text.delta` / `session.reasoning.delta`，增量喂检测器 |
| 切断 | `session.interrupt` 中止当前执行 |
| 上下文清洗 | `session.hook("context")` 每次模型请求组装前重写 messages |
| 压缩 | `session.hook("compaction")` 可注入确定性摘要、跳过压缩模型调用 |
| 自动续跑 | `session.prompt` 注入续跑指令 |
| retry 控制 | `session.hook("retry")` 精确控制重试决策 |
| 语言约束 | context hook 改写 `system` |
| 连救保护 | 连续救援次数上限 |
| debug 日志 | 可配置文件日志 |

## 3. OpenCode v2 插件体系（源码验证结论）

### 3.1 插件形态：default export，两种写法

服务端入口模块必须 **default export** 一个定义对象（`packages/core/src/plugin/module.ts:74-90` 的 `Module` schema）：

```ts
// 形式 A：Promise API（本项目采用，无需引入 Effect）
// packages/plugin/src/promise/plugin.ts:64
export default define({
  id: "loop-recover",
  setup: async (ctx) => {
    // ...注册订阅与 hook，返回可选 cleanup
    return () => { /* dispose */ }
  },
})

// 形式 B：Effect API（内部插件使用）
// packages/plugin/src/effect/plugin.ts:55
export default define({ id: "loop-recover", effect: (ctx) => Effect.void })
```

- `define()` 来自 `@opencode/plugin`（**已发布 npm，latest 2.2.5**）
- Promise 适配层在 `packages/plugin/src/promise/adapter.ts`——`Stream` 转成
  `AsyncIterable`，hook 回调返回 Promise，`Registration.dispose` 转 `Promise<void>`
- `ctx.options` 是 `PluginOptions = Record<string, any>`——**官方插件配置通道**

### 3.2 加载机制（`packages/core/src/config/plugin/source.ts` + `module.ts`）

**配置字段是 `plugins`（复数）**，不是 `plugin`：

```jsonc
// opencode.json
{
  "plugins": [
    "opencode-loop-recover",                          // npm 包名 → npm.add() 自动安装
    { "package": "opencode-loop-recover",
      "options": { "mode": "rescue" } },              // options 原样传给 ctx.options
    "./relative/dir",                                 // 相对路径按 config 文件目录解析
    "file:///abs/dir",                                // file:// URL
    "-some-other-plugin"                              // 前缀 "-" = 显式移除
  ]
}
```

- 非绝对路径的 target 走 `npm.add()` 自动安装（`module.ts:103-108`）
- 配置根的 `plugin/`、`plugins/` 子目录自动发现（`plugin/source-directory.ts`），
  其中 `.ts`/`.js` 文件和目录都可作为插件源
- 本地目录若 `package.json` 有 `name`+`exports` 按包解析，否则按常规文件名

**入口点解析**（`packages/plugin/src/host.ts:25-56` `Host.resolve`）：
每个插件包最多解析 4 个入口——`server`（服务端逻辑，本插件用）、`tui`、`rpc`、
`gui-experimental`（CJS bundle）。按 exports 子路径 `./server` 优先，回退根入口。
→ **本包需提供 `./server` export（或根 index）**。

### 3.3 关键能力（源码依据）

**事件订阅**（`plugin/src/effect/event.ts` + `core/src/plugin/host.ts:265-279`）：

```ts
// Promise API 下返回 AsyncIterable
const events = ctx.event.subscribe({ types: ["session.text.delta", ...] })
for await (const event of events) { ... }
```

- 不指定 types = 订阅全部公开事件；指定后按 `EventManifest.Server`/`Rpc` 过滤
- `ServerDefinitions`（`schema/src/event-manifest.ts:72`）经 `foundationDefinitions`
  包含**全部** `SessionEvent.Definitions`：
  `step.started/streamed/ended/failed`、`text.started/delta/ended`、
  `reasoning.started/delta/ended`、`tool.input.*`、`tool.called/progress/success/failed`、
  `compaction.started/delta/ended/failed`、`execution.*`、`retry.scheduled` 等
- delta 是发布器**实时批量推送**的（`core/src/session/runner/publish-llm-event.ts:169-208`
  定时 flush 批次），不是结束后补发——流内检测可行

**会话钩子**（`plugin/src/promise/session.ts:185-199`，`ModelHooks` 签名
`effect/registration.ts:18-25`）：

```ts
const reg = await ctx.session.hook("context", async (input) => { ... })
// input 即 SessionContext：{ sessionID, agent, model,
//   system: SystemPart[]   ← DeepMutable，语言约束/防复读指令注入点
//   messages: Message[]    ← DeepMutable，中毒上下文剔除点
//   tools: Record<...>     ← DeepMutable
//   options: SessionRequestOptions  ← DeepMutable（GenerationOptionsFields + 任意 key）
// }
```

全部 hook 名：`prompt`、`context`、`compaction`、`generate`、`title`、
`"model.request"`、`"http.request"`、`"http.response"`、
`"experimental.ws.handshake"/"send"/"receive"`、`retry`、`"experimental.idle"`

- **`model.request`**：`input.kind` 为 `"primary" | "compaction" | "title" | "generate"`
  ——主循环请求与辅助请求原生可区分（§5.2）
- **`compaction`**：`input.result = { summary, native?, tokens? }` 时**跳过压缩模型请求**，
  可做确定性压缩（`SessionCompaction` docstring，`promise/session.ts:40-52`）
- **`retry`**：`input.decision = { retry: false } | { retry: true, delay }`
- **`http.response`**：`input.response: Response` 可整体替换（§6.3）

**会话操作**（`SessionDomain`，`promise/session.ts:201-218`）：

`list`/`create`/`get`/`remove`/`switchAgent`/`switchModel`/`prompt`/`generate`/
`command`/`compact`/`synthetic`/`interrupt`/`update`/`move`/`context` +
experimental `wait`/`instructions`

- `interrupt` 中止执行（对应 `Execution.Interrupted`）
- `prompt` 注入用户可见输入；`synthetic` 注入控制/合成项
- `wait` 可等待 session 进入 idle——**续跑前先等 interrupt 完成的排序手段**

### 3.4 与 dsh 能力映射

| dsh 机制 | opencode v2 | 差异 |
|---|---|---|
| `llm/stream` + `isAgentLoopRequest`（WeakSet 实例坑） | `model.request` 的 `kind === "primary"` | ✅ 原生可靠 |
| 流内观测 | `event.subscribe` → delta 事件（实时批量推送） | ✅ |
| 中途切断 | `session.interrupt` | ✅ |
| 流内改块 | 无专用 hook；interrupt + context hook 清洗（§6.3 有进阶方案） | ⚠️ 切断点稍晚 |
| surfaceOp replace 压缩 | `context` hook 重写 messages（模型视角）+ `compaction` hook | ✅ 官方支持、非破坏 |
| `followup()` | `session.prompt`（配 `session.wait` 排序） | ✅ |
| retry 温度扰动 | `retry` hook 的 `decision` | ✅ 更精确 |
| `tools/post-execute` | `tool.called`/`success`/`failed` 事件 | ✅ |
| keepLanguage | `context` hook 改 `system` | ✅ |
| client.js GUI | v2 `tui`/`gui-experimental` 入口（二期） | 二期 |

## 4. 架构设计

```
opencode-loop-recover/
├── src/
│   ├── server.ts           # default export define({id, setup})——插件入口
│   ├── watch.ts            # delta 订阅循环 + 检测驱动
│   ├── rescue.ts           # 救援状态机：detect→interrupt→mark→resume→计数
│   ├── hooks.ts            # context/compaction/model.request/retry hook 注册
│   ├── buffer.ts           # 每 session/part 的滚动文本缓冲
│   ├── detect/             # 检测核心——dsh 版 vendored（纯函数、零宿主依赖）
│   │   ├── detector.ts
│   │   └── intent.ts
│   ├── config.ts           # ctx.options → 运行时配置（带默认值合并）
│   ├── i18n.ts             # zh/en 文案
│   └── log.ts              # debug 日志
├── test/                   # node --test
├── docs/
│   ├── design.md
│   └── code/opencode/      # 上游源码参考（.gitignore 排除）
├── package.json
├── tsconfig.json
└── README.md / README.zh-CN.md
```

**package.json 要点**：
- `exports`: `{ "./server": "./dist/server.js" }`（入口解析 §3.2）
- `devDependencies`: `@opencode/plugin`（类型）+ `typescript`；
  `peerDependencies` 标 `@opencode/plugin`（宿主运行时提供，避免双实例）
- `files`: `dist`（编译产物；npm 包必须发 JS——v2 加载器 `Host.load` 走
  `importModule`，本地 `.ts` 能跑但 node_modules 下的 `.ts` 有风险，
  与 dsh 版踩过的 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 同坑，直接编译）

### 4.1 检测核心复用

`detector.ts`、`intent.ts` 纯函数整文件 vendored，连同其单测。
后续双仓库演进稳定后再抽 `loop-detect-core` 共享包。

### 4.2 会话状态

```ts
interface SessionWatch {
  sessionID: string
  buffers: Map<string, RollingTextBuffer>   // partID → 累计 text/reasoning
  rescueCount: number                        // 连续救援计数
  lastRescueAt: number
  poisoned: { messageID: string; partID: string; cutOffset: number }[]
}
```

## 5. 救援链时序

```
模型流式输出
  └─ session.text.delta / session.reasoning.delta ──→ buffer 追加 + 检测器扫描
        │
        ├─ 未命中 → 继续
        │
        └─ 命中 ──→ mode 分支
              observe: 写日志，返回
              rescue/cut:
                1. ctx.session.interrupt(...)              ← 中止执行
                2. 记录 poisoned { messageID, partID, cutOffset }
                3. ctx.session.wait(...)（等 idle，排序）── cut 模式到此为止
                4. ctx.session.prompt(...)                  ← 续跑指令
                5. rescueCount++；≥ maxRescues → 停止干预并提示用户
              下次模型请求组装时：
                6. context hook: messages 剔除/截断中毒尾部，
                   system 追加防复读+语言约束，options 温度扰动
```

**切断语义**：`interrupt` 触发 `Execution.Interrupted`，释放执行权。
已生成文本留在 transcript（用户短暂可见重复段），但 **context hook 保证
模型下一轮看不到中毒内容**——与 dsh 版的核心等价物。

### 5.2 辅助请求豁免

只对 `model.request` 的 `kind === "primary"` 关联的 session 检测，
`compaction`/`title`/`generate` 类请求天然放行——无需 dsh 版的 WeakSet 兜底。

## 6. 关键设计细节

### 6.1 缓冲与检测时机

- 每 `sessionID+partID` 滚动窗口（默认尾部 ~8KB，可配）
- delta 事件增量喂检测器，命中即 `interrupt`
- part 结束重置周期检测状态；池检测器跨 part 保留
- 事件循环自 setup 里 `for await` 驱动，与插件生命周期同 scope

### 6.2 中毒标记与 context 清洗

- 命中时记录 `{ messageID, partID, cutOffset }`
- `context` hook 注册一次，每次模型请求组装时：
  - 按 sessionID 查 poisoned 标记
  - messages 中对应 part 的 text 截断至 cutOffset + 占位提示
  - system 追加防复读指令 + keepLanguage 约束
  - options 施加温度/topP 扰动（降级 retry hook 之外的保险）
- 清洗只影响**发给模型的 messages**，不改写磁盘 transcript（非破坏式）

### 6.3 进阶：真·流内改写（二期可选）

`session.hook("http.response")` 的 `response` 可整体替换——包一层
TransformStream 对 SSE 流实时过滤，可实现与 dsh 完全等价的"中途静默截断"。
风险：provider driver 按原协议状态推进（`SessionWebSocketReceive` docstring
有同类警告），改写须保持协议一致。v1 不实现。

### 6.4 连续救援保护

`rescueCount ≥ maxRescues`（默认 3）→ 该 session 转 observe + 注入提示。
同一 session 的后续 `prompt` 重置计数时机需 e2e 验证。

### 6.5 意图级检测

- `tool.called`/`tool.success`/`tool.failed` 事件 → `intent.ts` 记录查询签名
- 语义重复 → 下轮 context hook 注入转向指令
- （增强项：评估 `context` hook 里直接编辑该工具结果内容，比 dsh 注消息更精准）

## 7. 配置设计

**官方通道**：`ctx.options`（对应 `plugins: [{package, options}]` 的 `options`）：

```jsonc
"plugins": [{
  "package": "opencode-loop-recover",
  "options": {
    "mode": "rescue",            // rescue | cut | observe，默认 rescue
    "detectors": { "periodic": true, "ngram": true, "anchor": true,
                   "charRun": true, "pool": true, "intent": true },
    "thresholds": { "...": "沿用 dsh 版默认值" },
    "maxRescues": 3,
    "rescuePrompt": "……续跑指令模板",
    "keepLanguage": true,
    "debugLog": false            // false | 日志文件路径
  }
}]
```

unknown/缺省 key 全部回落默认值；不做独立配置文件（官方 options 已够用）。

## 8. 测试策略

`node --test test/*.test.mjs`，与 dsh 版同构：

| 层 | 内容 |
|---|---|
| 检测器单测 | vendored 代码连同测试一起搬 |
| 救援状态机 | mock `ctx`：伪 delta 事件流 → 断言 interrupt 调用 → context hook 清洗 → prompt |
| hook 测试 | 构造 `SessionContext` 输入，验证 messages/system/options 改写 |
| 集成回归 | `test/fixtures-real-loop.txt`（dsh 版沿用） |
| e2e（手动） | 本机 opencode + 小模型，接龙 prompt 触发真循环走完整链路 |

## 9. 发布与分发

| 步骤 | 说明 |
|---|---|
| npm | `opencode-loop-recover`（当前未被占用）；用户 `plugins` 数组加包名自动装 |
| awesome-opencode | fork → `data/plugins/opencode-loop-recover.yaml` → PR |
| 官网 ecosystem 页 | sst/opencode docs PR |
| 命名 | `opencode-loop` 已被编排器占用（★208）；`-recover` 与 dsh 版品牌一致 |

## 10. 里程碑

| # | 内容 | 产出 |
|---|---|---|
| M0 | **spike**：最简插件验证 delta 事件节奏 + interrupt 语义 + wait 排序 | 可行性确认（半天） |
| M1 | 脚手架 + vendored 检测核心 + 单测 | `npm test` 绿 |
| M2 | 订阅 + 缓冲 + interrupt + context 清洗 + prompt 续跑 | 最小救援链 |
| M3 | 意图检测 + keepLanguage + options 配置 + 连救保护 + 日志 | 功能对齐 dsh 版 |
| M4 | e2e 真机 + README + npm 发布 | 可安装 |
| M5 | awesome-opencode / ecosystem 投稿 | 上架 |
| M6（可选） | http.response 流内改写、tui/gui 面板 | 增强 |

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| delta 事件对插件的推送节奏不及预期 | 源码已证实时批量推送（publish-llm-event 定时 flush）；M0 spike 实测，兜底转 part 完成后检测 |
| `interrupt` 后 part 落盘状态 | M0 验证；context hook 保证模型侧干净，transcript 留残可接受 |
| v2 API 演进 | `@opencode/plugin` 已正式发布（2.2.5）；hooks 名含 `experimental.` 前缀的才是不稳定项，核心 hook 无前缀 |
| 检测核心双仓库漂移 | 初期 vendored，稳定后抽 `loop-detect-core` |
| `interrupt` 打断工具执行副作用 | 只在 delta 流命中时 interrupt；工具执行中不切断 |

## 12. 参考

- `docs/code/opencode/`（本地参考，.gitignore）
  - 插件定义：`packages/plugin/src/promise/plugin.ts`、`effect/plugin.ts`
  - 会话钩子：`packages/plugin/src/{promise,effect}/session.ts`
  - 事件清单：`packages/schema/src/event-manifest.ts`、`session-event.ts`
  - 插件宿主/加载：`packages/core/src/plugin/{host.ts,module.ts,source-directory.ts}`
  - 配置源：`packages/core/src/config/plugin/source.ts`
  - delta 发布：`packages/core/src/session/runner/publish-llm-event.ts`
- dsh 版：`/Volumes/2t/code/dsh-loop-recover`
