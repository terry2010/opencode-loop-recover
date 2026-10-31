# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**中文文档**：[README.zh-CN.md](README.zh-CN.md)

**Stops your AI agent when it gets stuck repeating itself.**

If you run local or smaller models in OpenCode, you've probably seen this: the model starts writing the same sentence (or `ssssss…`) over and over, burning tokens until you manually stop it or the session dies.

This plugin watches what the model writes **as it writes it**. The moment it spots a repetition loop, it:

1. **Stops** the runaway generation
2. **Cleans up** — removes the repeated junk from the model's view of the conversation
3. **Continues** the task automatically, with a nudge to try a different approach

No restart. No babysitting. The session just keeps going.

## Install

Add one line to your `opencode.json`:

```jsonc
{
  "plugins": ["opencode-loop-recover"]
}
```

That's it. OpenCode installs it automatically next time it starts.

## What it catches

- `ssssssss…` — character floods (a sign of model collapse)
- The same sentence/paragraph repeated over and over
- Thinking that goes in circles (repeating the same analysis)
- The agent re-asking the same search/query with slightly different wording
- Scattered short-sentence repetition spread across output

## Three modes

```jsonc
{
  "plugins": [{
    "package": "opencode-loop-recover",
    "options": { "mode": "rescue" }
  }]
}
```

| Mode | Behavior |
|---|---|
| `rescue` (default) | Stop the loop, clean up, auto-continue |
| `cut` | Just stop — you take over |
| `observe` | Watch and log only, never touch anything (good for testing) |

## What you'll see

When it fires, a marked message appears in the session:

```
⛑ [loop-recover] The previous output was detected as a repetition loop
and has been interrupted and pruned. Continue the original task…
```

And it stops after several consecutive rescues in one session instead of fighting the model forever — you'll get a heads-up to intervene manually.

## All options (with defaults)

```jsonc
{
  "plugins": [{
    "package": "opencode-loop-recover",
    "options": {
      "mode": "rescue",            // rescue | cut | observe
      "detectors": {               // turn individual detectors on/off
        "periodic": true, "ngram": true, "anchor": true,
        "charrun": true, "pool": true, "intent": true
      },
      "maxRescues": 3,             // give up after this many consecutive rescues
      "bufferChars": 8192,         // how much recent output is analyzed
      "keepLanguage": true,        // remind the model to keep its language
      "language": "auto",          // auto | zh | en
      "temperatureBump": 0.3,      // jitter added after rescue (0 = off)
      "rescuePrompt": "…",         // custom "please continue" message
      "debugLog": false,           // or "/path/to/debug.log" for troubleshooting
      "intent": {                  // same-query detection for tools
        "toolPatterns": ["web_search"],
        "stallLimit": 2
      }
    }
  }]
}
```

## What it doesn't do

- Doesn't flag repetition in shell output, files, or tool results — only what the **model itself generates**
- Doesn't touch title/summary/side requests
- Doesn't have a settings UI — all config lives in `opencode.json`

## FAQ

**Will it interrupt normal output?** Rarely — it needs several consecutive repeats of the same content before acting, and you can run `mode: "observe"` first to check for false positives in your workload.

**Does it work with cloud models?** Yes, but it's mainly useful for local/small models that are prone to degeneration.

**Does it change what's saved in the session?** The repeated text stays in your transcript, but the *model* never sees it again — it's trimmed from the context on every subsequent request.

## Development

```bash
npm test        # 78 tests: detectors, adapters, full recovery chain
npm run build   # compile to dist/
```

Design doc: [docs/design.md](docs/design.md). Detection core shared with [dsh-loop-recover](https://github.com/terry2010/dsh-loop-recover) (same thing for DeepSeek Harness).

## License

MIT
