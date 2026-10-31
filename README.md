# opencode-loop-recover

[![npm](https://img.shields.io/npm/v/opencode-loop-recover)](https://www.npmjs.com/package/opencode-loop-recover)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**中文文档**：[README.zh-CN.md](https://github.com/terry2010/opencode-loop-recover/blob/master/README.zh-CN.md)

Loop guard for OpenCode: detects model repetition mid-stream, interrupts the loop, prunes the poisoned context, and resumes the task automatically.

Local and small-parameter models can degrade into two pathological loop patterns during long tasks:

- **Literal collapse**: `ssssss...`, single-character or fixed-period token floods
- **Semantic loops**: reasoning repeats the same analysis, or the agent re-issues the same tool query with reworded arguments

Without intervention the loop burns tokens until the session dies. This plugin watches the stream, cuts the loop, removes the poisoned tail from the model's view, and continues the original task — no restart, no manual babysitting.

## How it works

```
model streams text
   └─ session.text.delta / session.reasoning.delta → rolling buffer + detectors
        └─ hit ─→ session.interrupt()           (cut)
                → poison mark recorded           (fingerprint of the repeated tail)
                → session.wait() → session.prompt()   (auto-resume)
        next model request:
                → context hook prunes the poisoned tail from messages
                → system hint: don't repeat; keep language
                → options temperature perturbation
```

Five detector layers plus intent-level tracking:

| Detector | Catches |
|---|---|
| periodic | fixed-period text repeated ≥4 times |
| charrun | single substantive char flood (`ssss…`) |
| n-gram | 64-char block appearing ≥3 times in tail window |
| anchor | large tail block re-appearing earlier |
| pool | scattered short-sentence repetition |
| intent | reworded-but-identical tool queries |

## Modes

- `rescue` (default): interrupt → prune → resume automatically
- `cut`: interrupt only, hand back to the user
- `observe`: detect and log, never intervene

## Install

```jsonc
// opencode.json (or ~/.config/opencode/opencode.json)
{
  "plugins": ["opencode-loop-recover"]
}
```

OpenCode installs npm plugins automatically at startup.

## Configuration

All options are optional; shown with defaults:

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
      "maxRescues": 3,                 // consecutive rescues per session before giving up
      "bufferChars": 8192,             // rolling tail window fed to detectors
      "keepLanguage": true,            // inject language-preserving hint after rescue
      "language": "auto",              // auto | zh | en (auto falls back to en)
      "temperatureBump": 0.3,          // perturbation on the request after rescue; 0 disables
      "rescuePrompt": "…",             // custom resume instruction
      "debugLog": false,               // false | "/path/to/loop-recover-debug.log"
      "intent": {                      // intent-level detector options
        "toolPatterns": ["web_search"],
        "stallLimit": 2,
        "noveltyThreshold": 0.25,
        "similarityThreshold": 0.5
      },
      "thresholds": { /* detector internals: ngramSize, periodRepeats, runMinChars, … */ }
    }
  }]
}
```

## Notes

- The cut point is `session.interrupt` — the repeated text remains visible in the transcript briefly, but the **model never sees the poisoned tail again**: the `context` hook prunes it from `messages` on every subsequent request (non-destructive; disk history untouched).
- After `maxRescues` consecutive rescues the plugin stops intervening for that session and injects a notice hint.
- Auxiliary requests (title/summary/generate/compaction) are unaffected — loop watching is tied to real session output.

## Development

```bash
npm test          # node --test, detector + adapter + integration
npm run build     # tsc → dist/
npm run check     # verify default-export plugin shape
```

Design doc: [docs/design.md](docs/design.md). Detector core vendored from [dsh-loop-recover](https://github.com/terry2010/dsh-loop-recover).

## License

MIT
