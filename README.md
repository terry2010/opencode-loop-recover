# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文](README.zh-CN.md) · English

> Detect model repetition loops and recover the task in the same OpenCode session.

## The problem

A model can get stuck repeating the same words or reasoning. The response grows, but the task makes no progress. A basic loop guard may stop generation, leaving you to restart or continue manually.

`opencode-loop-recover` is built to do more than stop the stream: it detects repeated output, interrupts generation, removes the repeated tail from the context used for the next model request, and asks the model to continue the original task.

It monitors both the visible response and the model's reasoning stream. It is particularly useful with local and smaller models, where repetition loops can occur during long sessions.

## Recovery flow

```text
repeated model output
        ↓
interrupt generation
        ↓
exclude the repeated tail from the next model context
        ↓
resume the task in the same session
```

The transcript is preserved. Cleanup applies to the context sent to the model after the interruption.

## Install

```bash
opencode plugin add opencode-loop-recover
```

This installs the npm package and writes it to your global `opencode.json` automatically. Restart OpenCode afterwards.

Or edit `opencode.json` by hand:

```json
{
  "plugins": ["opencode-loop-recover"]
}
```

## Modes

The default mode is `rescue`.

| Mode | What happens |
| --- | --- |
| `rescue` | Interrupt the loop, clean the next model context, and resume the task. |
| `cut` | Interrupt the loop without resuming automatically. |
| `observe` | Detect and log loops without interrupting. |

To change the mode:

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

## Desktop settings page

OpenCode Desktop can edit the configuration directly: **Settings → Loop Recover**. The page exposes every option — mode, language, rescue limits, temperature bump, per-detector switches, and the advanced thresholds. Changes are written back to the global `opencode.json` (comments preserved) and take effect automatically on reload. The TUI and the desktop app share the same configuration.

## What it detects

- Repeated phrases or passages in generated text.
- Repetition in the model's reasoning stream.
- Long runs of the same character, such as `ssssss...`.
- Repeated tool queries; these trigger a steering hint rather than an immediate stream interruption.

The plugin acts only on repetition patterns it recognizes; it does not evaluate whether an answer is correct. Detection needs enough repeated content to confirm a pattern, so some repetition may appear before the interruption. Shell output, files, and tool results are not monitored.

## License

MIT
