# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English**: [README.md](README.md)

**模型卡壳刷屏时，帮你自动救回来。**

如果你在 OpenCode 里跑本地或小参数模型，大概见过这种情况：模型开始一遍又一遍写同一句话（或者 `ssssss…` 刷屏），一直烧 token，直到你手动打断或者会话废掉。

这个插件会在模型**边写边看**。一旦发现它在复读，立刻：

1. **停掉**失控的生成
2. **清理**——把复读的垃圾内容从模型视野里删掉
3. **自动继续**原任务，顺带提醒它换个思路

不用重启、不用盯梢，会话自己接着跑。

## 安装

`opencode.json` 里加一行：

```jsonc
{
  "plugins": ["opencode-loop-recover"]
}
```

就这一行。下次启动 OpenCode 会自动装好。

## 能抓什么情况

- `ssssssss…` 单字符刷屏（模型坍缩的典型症状）
- 同一句话/同一段话反复写
- 思考过程原地打转（反复念叨同一段分析）
- 换个措辞反复发同一个搜索/查询
- 散在输出里的短句复读

## 三种模式

```jsonc
{
  "plugins": [{
    "package": "opencode-loop-recover",
    "options": { "mode": "rescue" }
  }]
}
```

| 模式 | 行为 |
|---|---|
| `rescue`（默认） | 停住循环、清理、自动继续 |
| `cut` | 只停住——交给你处理 |
| `observe` | 只看不碰，光记日志（适合先试试） |

## 触发时你会看到

会话里出现一条带标记的消息：

```
⛑ [loop-recover] 刚才的输出检测到重复循环，已被中断并清理。请换一种思路继续…
```

同一个会话连续救好几次还不停的话，插件会放弃自动干预并提醒你手动看看——不会跟模型死磕到底。

## 全部配置项（附默认值）

```jsonc
{
  "plugins": [{
    "package": "opencode-loop-recover",
    "options": {
      "mode": "rescue",            // rescue | cut | observe
      "detectors": {               // 单独开关某个检测器
        "periodic": true, "ngram": true, "anchor": true,
        "charrun": true, "pool": true, "intent": true
      },
      "maxRescues": 3,             // 连续救这么多次后放弃
      "bufferChars": 8192,         // 分析多长的最近输出
      "keepLanguage": true,        // 提醒模型保持语言
      "language": "auto",          // auto | zh | en
      "temperatureBump": 0.3,      // 救援后的随机扰动（0 = 关闭）
      "rescuePrompt": "…",         // 自定义"请继续"的提示语
      "debugLog": false,           // 或 "/path/to/debug.log" 排查问题用
      "intent": {                  // 同一查询的重复检测
        "toolPatterns": ["web_search"],
        "stallLimit": 2
      }
    }
  }]
}
```

## 它不管的事

- 不管 shell 输出、文件内容、工具返回里的重复——只看**模型自己生成**的
- 不碰标题生成、摘要这类辅助请求
- 没有设置界面——所有配置都在 `opencode.json`

## 常见问题

**会不会误伤正常输出？** 很少——要连续重复好几次同一内容才会动手。不放心可以先用 `mode: "observe"` 跑几天，只看日志不干预。

**云端大模型有用吗？** 能用，但主要是给容易退化的本地/小模型准备的。

**会改会话记录吗？** 重复文本在记录里还在，但**模型从此看不到它**——每次后续请求都会把它从上下文里剪掉。

## 开发

```bash
npm test        # 78 个测试：检测器、适配层、完整救援链
npm run build   # 编译到 dist/
```

设计文档：[docs/design.md](docs/design.md)。检测核心与 [dsh-loop-recover](https://github.com/terry2010/dsh-loop-recover) 共用（DeepSeek Harness 的同款插件）。

## License

MIT
