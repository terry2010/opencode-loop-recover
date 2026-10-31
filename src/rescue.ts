import {
  detectAnchor,
  detectCharRun,
  detectNgram,
  detectPeriodic,
  detectPoolRepeat,
  type LoopHit,
} from './detect/detector.ts'
import { IntentTracker, extractQueryText, matchesTool } from './detect/intent.ts'
import type { Config } from './config.ts'
import type { Lang, Strings } from './i18n.ts'

/** 宿主会话操作——server.ts 里接 ctx.session，测试里注入 mock。 */
export interface RescueOps {
  interrupt(sessionID: string): Promise<unknown>
  prompt(sessionID: string, text: string): Promise<unknown>
  /** 等 session 空闲；实现必须 resolve（host 无 wait 时由调用方兜底）。 */
  waitIdle(sessionID: string): Promise<unknown>
  log(msg: string): void
}

/** 中毒标记：命中时刻的缓冲指纹，context hook 据此在 messages 里定位截断。 */
export interface PoisonMark {
  messageID: string
  ordinal: number
  /** 重复区起始处的文本切片——在 part 文本中 indexOf 定位截断点 */
  fingerprint: string
  kind: LoopHit['kind']
  at: number
}

export interface SessionWatch {
  rescueCount: number
  lastRescueAt: number
  gaveUp: boolean
  /** context hook 待注入：防复读约束（救援后一次）、转向提示（意图命中后一次）、放弃提示 */
  guardHintPending: boolean
  steerPending: boolean
  giveUpPending: boolean
  /** 下次模型请求需要温度扰动 */
  temperatureBumpPending: boolean
  poisoned: PoisonMark[]
  /** 已中断过的 part（`${messageID}:${ordinal}`）——命中后剩余 delta 不再重复救 */
  interruptedParts: Set<string>
  intent: IntentTracker
  resuming: boolean
}

const FINGERPRINT_CHARS = 64

/** 按开关逐项跑检测器；返回第一个命中（周期类优先级高于池类）。 */
export function runDetectors(text: string, cfg: Config): LoopHit | null {
  const d = cfg.detectors
  const o = cfg.detector
  if (d.periodic) {
    const hit = detectPeriodic(text, o)
    if (hit) return hit
  }
  if (d.charrun) {
    const hit = detectCharRun(text, o)
    if (hit) return hit
  }
  if (d.ngram) {
    const hit = detectNgram(text, o)
    if (hit) return hit
  }
  if (d.anchor) {
    const hit = detectAnchor(text, o)
    if (hit) return hit
  }
  if (d.pool) {
    const hit = detectPoolRepeat(text, o)
    if (hit) return hit
  }
  return null
}

export class RescueManager {
  private watches = new Map<string, SessionWatch>()

  private readonly cfg: Config
  private readonly ops: RescueOps
  private readonly lang: Lang
  private readonly i18n: Strings

  constructor(cfg: Config, ops: RescueOps, lang: Lang, i18n: Strings) {
    this.cfg = cfg
    this.ops = ops
    this.lang = lang
    this.i18n = i18n
  }

  watch(sessionID: string): SessionWatch {
    let w = this.watches.get(sessionID)
    if (!w) {
      w = {
        rescueCount: 0,
        lastRescueAt: 0,
        gaveUp: false,
        guardHintPending: false,
        steerPending: false,
        giveUpPending: false,
        temperatureBumpPending: false,
        poisoned: [],
        interruptedParts: new Set(),
        intent: new IntentTracker(this.cfg.intent),
        resuming: false,
      }
      this.watches.set(sessionID, w)
    }
    return w
  }

  peek(sessionID: string): SessionWatch | undefined {
    return this.watches.get(sessionID)
  }

  drop(sessionID: string): void {
    this.watches.delete(sessionID)
  }

  /**
   * 流内增量检测。delta 已并入调用方的缓冲，这里拿到的是 part 累计文本尾部。
   * @returns 命中时返回 LoopHit（未干预也会返回，便于日志/测试）
   */
  async onStreamText(
    sessionID: string,
    messageID: string,
    ordinal: number,
    text: string,
  ): Promise<LoopHit | null> {
    const hit = runDetectors(text, this.cfg)
    if (!hit) return null

    const w = this.watch(sessionID)
    this.ops.log(
      `loop detected session=${sessionID} kind=${hit.kind} period=${hit.period ?? '-'} ` +
        `rescues=${w.rescueCount} mode=${this.cfg.mode} detail=${hit.detail}`,
    )
    if (this.cfg.mode === 'observe' || w.gaveUp) return hit

    const partKey = `${messageID}:${ordinal}`
    if (w.interruptedParts.has(partKey)) return hit

    if (w.rescueCount >= this.cfg.maxRescues) {
      w.gaveUp = true
      w.giveUpPending = true
      this.ops.log(`rescue limit reached session=${sessionID}, switching to observe`)
      return hit
    }

    w.interruptedParts.add(partKey)

    // 记录中毒标记：fingerprint 取重复区起始切片，供 context hook 定位
    const cut = hit.cutStart ?? Math.max(0, text.length - this.cfg.detector.ngramSize)
    w.poisoned.push({
      messageID,
      ordinal,
      fingerprint: text.slice(cut, cut + FINGERPRINT_CHARS),
      kind: hit.kind,
      at: Date.now(),
    })
    w.rescueCount += 1
    w.lastRescueAt = Date.now()
    w.temperatureBumpPending = true

    await this.ops.interrupt(sessionID)
    this.ops.log(`interrupted session=${sessionID} kind=${hit.kind}`)

    if (this.cfg.mode === 'cut') return hit

    // rescue：等执行权释放后注入续跑 prompt（resuming 防抖）
    if (!w.resuming) {
      w.resuming = true
      w.guardHintPending = true
      this.resume(sessionID)
        .catch((cause) => this.ops.log(`resume failed session=${sessionID}: ${cause}`))
        .finally(() => {
          w.resuming = false
        })
    }
    return hit
  }

  private async resume(sessionID: string): Promise<void> {
    await this.ops.waitIdle(sessionID)
    const prompt = this.cfg.rescuePrompt ?? this.i18n.resumePrompt
    await this.ops.prompt(sessionID, prompt)
    this.ops.log(`resumed session=${sessionID}`)
  }

  /**
   * 工具调用记录（意图级检测）。返回 true 表示语义重复、应注入转向提示。
   * 意图循环不 interrupt——下轮 context hook 注入 steerHint 让模型自己转向。
   */
  onToolCall(sessionID: string, toolName: string, input: unknown): boolean {
    if (!this.cfg.detectors.intent) return false
    if (!matchesTool(toolName, this.cfg.intent.toolPatterns)) return false
    const w = this.watch(sessionID)
    const query = extractQueryText(input, this.cfg.intent.maxQueryChars)
    const verdict = w.intent.observe(query)
    if (verdict.repeat) {
      w.steerPending = true
      this.ops.log(
        `intent loop session=${sessionID} tool=${toolName} stall=${verdict.stall} ` +
          `novelty=${verdict.novelty.toFixed(2)} similarity=${verdict.similarity.toFixed(2)}`,
      )
      return true
    }
    return false
  }

  /**
   * context hook 消费：返回本 session 需要注入的内容并清除 pending 标记。
   * 由 hooks.ts 在每次模型请求组装时调用。
   */
  consumeDirectives(sessionID: string): {
    guardHint?: string
    steerHint?: string
    giveUpHint?: string
    temperatureBump: number
    poisoned: PoisonMark[]
  } {
    const w = this.watches.get(sessionID)
    const out = { temperatureBump: 0, poisoned: [] as PoisonMark[] } as {
      guardHint?: string
      steerHint?: string
      giveUpHint?: string
      temperatureBump: number
      poisoned: PoisonMark[]
    }
    if (!w) return out
    if (w.guardHintPending) {
      out.guardHint = this.i18n.guardHint
      w.guardHintPending = false
    }
    if (w.steerPending) {
      out.steerHint = this.i18n.steerHint
      w.steerPending = false
    }
    if (w.giveUpPending) {
      out.giveUpHint = this.i18n.giveUpHint
      w.giveUpPending = false
    }
    if (w.temperatureBumpPending) {
      out.temperatureBump = this.cfg.temperatureBump
      w.temperatureBumpPending = false
    }
    out.poisoned = w.poisoned.slice()
    return out
  }
}
