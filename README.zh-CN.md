# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English**: [README.md](https://github.com/terry2010/opencode-loop-recover/blob/master/README.md)

OpenCode 死循环防护：流内检测模型重复输出，中断循环，清洗中毒上下文，自动原地续跑任务。

本地/小参数模型在长任务中容易退化出两类病理循环：

- **字面坍缩**：`ssssss...`、单字符或固定周期刷屏
- **语义循环**：reasoning 反复复读同一段分析，或换措辞重复发起同样的工具查询

不干预就会一直烧 token 直到会话报废。本插件盯着流，发现循环即切断、从模型视野中剔除中毒尾部、继续原任务——不用重启、不用人盯。

## 工作原理

```
模型流式输出
   └─ session.text.delta / reasoning.delta → 滚动缓冲 + 检测器
        └─ 命中 ─→ session.interrupt()        （切断）
                → 记录中毒标记                （重复尾部指纹）
                → session.wait() → prompt()   （自动续跑）
        下一次模型请求：
                → context hook 从 messages 截断中毒尾部
                → system 注入防复读 + 语言约束
                → options 温度扰动
```

五层检测器 + 意图级追踪：

| 检测器 | 抓什么 |
|---|---|
| periodic | 固定周期文本重复 ≥4 次 |
| charrun | 单字符刷屏（`ssss…`） |
| n-gram | 64 字符块尾窗内出现 ≥3 次 |
| anchor | 大段尾部在更早文本中再现 |
| pool | 散点短句复读 |
| intent | 换措辞的同一工具查询 |

## 三种模式

- `rescue`（默认）：中断 → 清洗 → 自动续跑
- `cut`：只中断，交还用户
- `observe`：只检测记录，不干预

## 安装

```jsonc
// opencode.json（或 ~/.config/opencode/opencode.json）
{
  "plugins": ["opencode-loop-recover"]
}
```

OpenCode 启动时自动安装 npm 插件。

## 配置

全部为可选项，下列为默认值：

```jsonc
{
  "plugins": [{
    "package": "opencode-loop-recover",
    "options": {
      "mode": "rescue",               // rescue | cut | observe
      "detectors": {
        "periodic": true, "ngram": true, "anchor": true,
        "charrun": true, "pool": true, "intent": true
      },
      "maxRescues": 3,                 // 单 session 连续救援上限，超限转 observe
      "bufferChars": 8192,             // 检测器滚动尾窗
      "keepLanguage": true,            // 救援后注入语言保持约束
      "language": "auto",              // auto | zh | en（auto 回落 en）
      "temperatureBump": 0.3,          // 救援后下次请求的温度扰动；0 关闭
      "rescuePrompt": "…",             // 自定义续跑指令
      "debugLog": false,               // false | "/path/to/loop-recover-debug.log"
      "intent": {                      // 意图级检测选项
        "toolPatterns": ["web_search"],
        "stallLimit": 2,
        "noveltyThreshold": 0.25,
        "similarityThreshold": 0.5
      },
      "thresholds": { /* 检测器内部参数：ngramSize、periodRepeats、runMinChars 等 */ }
    }
  }]
}
```

## 说明

- 切断点是 `session.interrupt`——重复文本会在 transcript 里短暂可见，但**模型从此看不到中毒尾部**：每次后续请求前 `context` hook 都会从 `messages` 里截掉它（非破坏式，磁盘历史不动）。
- 连续救援达 `maxRescues` 次后该 session 停止自动干预，并注入提示。
- 辅助请求（标题/摘要/压缩等）不受影响。

## 开发

```bash
npm test          # node --test：检测器 + 适配层 + 集成
npm run build     # tsc → dist/
npm run check     # 校验 default-export 插件形态
```

设计文档：[docs/design.md](docs/design.md)。检测核心 vendored 自 [dsh-loop-recover](https://github.com/terry2010/dsh-loop-recover)。

## License

MIT
