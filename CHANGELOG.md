# Changelog

## 0.2.4

Detector core synced with dsh-loop-recover 0.3.7 — five-layer detection hardening, reasoning-stream false-positive relief.

### Detector

- `detectPoolRepeat` now splits on ASCII `.` — English repetition was invisible because sentences were never segmented.
- `detectNgram` samples every position by default (`ngramStep` 16 → 1) — the old alignment sampling missed most mid-size verbatim repeats at non-16-aligned distances.
- `detectCharRun` scans the whole tail window instead of only the very end — a spam run followed by normal tail text now hits.
- `detectRepetition` minimum-scan floor decoupled from `minPeriod × periodRepeats` (constant 32) — raising `minPeriod` no longer silently disables the pool/charrun layers on short text.
- `StreamLoopDetector` keeps only a bounded tail internally; `cutStart` is translated back to full-text coordinates, so memory stays flat on long blocks.

### Rescue / stream

- Reasoning blocks use relaxed thresholds (`poolMinRepeats ≥ 8`, `ngramRepeats ≥ 4`) — methodical enumeration with a repeated verdict sentence no longer triggers false positives; text blocks keep defaults. User-configured wider thresholds are respected.
- `RescueState` gains a cumulative `total` counter and `decideRescue` accepts `maxTotalRescues` — infrastructure for a total rescue cap (the plugin's per-session `maxRescues` already acts as one).

### Intent

- History entries expire after `maxAgeMs` (default 30 min) — stale topics from a previous task no longer cause false intent-loop verdicts.

### Tests / docs

- detector / intent / stream-core suites synced with the dsh repo, plus a rescue-level reasoning-relaxation case — 111 tests green.
