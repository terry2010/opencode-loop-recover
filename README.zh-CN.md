# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · 中文

> 检测模型重复输出，并在同一个 OpenCode 会话中恢复任务。

## 解决什么问题

模型有时会卡在重复输出里：反复写相同的词句或思考内容，回答不断变长，任务却没有进展。普通循环守卫可能只会停止生成，后续还得由你手动处理。

`opencode-loop-recover` 不只负责停止生成。它会检测重复内容、中断本轮生成、避免模型在下一次请求中再次看到重复尾部，并提示模型继续原任务。

插件同时监测用户可见的回答流和模型思考流。长时间使用本地模型或较小模型时尤其有用。

## 救援流程

```text
模型开始重复输出
        ↓
中断本轮生成
        ↓
从后续请求的模型上下文中移除重复尾部
        ↓
在同一个会话中继续原任务
```

原始会话记录会保留；清理只影响中断后发送给模型的上下文。

## 安装

```bash
opencode plugin add opencode-loop-recover
```

命令会自动安装 npm 包并写入全局 `opencode.json`，装完重启 OpenCode。

也可以手动改 `opencode.json`：

```json
{
  "plugins": ["opencode-loop-recover"]
}
```

## 工作模式

默认模式是 `rescue`。

| 模式 | 行为 |
| --- | --- |
| `rescue` | 中断循环、清理后续模型上下文，并继续原任务。 |
| `cut` | 中断循环，不自动续跑。 |
| `observe` | 只检测和记录，不中断生成。 |

修改模式示例：

```json
{
  "plugins": [
    {
      "package": "opencode-loop-recover",
      "options": { "mode": "observe" }
    }
  ]
}
```

## 检测范围

- 模型回答中的重复词句或段落。
- 模型思考流中的重复内容。
- `ssssss...` 这类长串相同字符。
- 重复的工具查询；检测到后会提示模型调整查询方式，而不是立即中断生成。

插件只处理能够识别的重复模式，不判断答案是否正确。检测需要足够的重复内容，因此中断前可能已经显示一部分重复文本。插件不监测 shell 输出、文件内容或工具返回结果。

## 许可协议

MIT
