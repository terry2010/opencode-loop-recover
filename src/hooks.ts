import type { Config } from './config.ts'
import type { RescueManager, PoisonMark } from './rescue.ts'
import type { Strings } from './i18n.ts'

/** SessionContext 的最小结构假设——按字段存在性探测，不依赖具体类型版本。 */
interface TextHolder {
  text: string
}

interface ContextInput {
  sessionID: string
  agent?: string
  model?: unknown
  system: unknown
  messages: unknown[]
  options?: Record<string, unknown>
}

/** 在 messages 树里找含 fingerprint 的文本字段并截断 + 追加占位标记。返回截断次数。 */
export function pruneMessages(messages: unknown[], poisoned: PoisonMark[], marker: string): number {
  if (poisoned.length === 0) return 0
  let pruned = 0
  const seen = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') {
      const holder = record as unknown as TextHolder
      for (const mark of poisoned) {
        const key = `${mark.messageID}:${mark.ordinal}`
        if (seen.has(key) || !mark.fingerprint) continue
        // lastIndexOf：重复区总在 part 尾部，取最后出现处避免误截前文同名内容
        const idx = holder.text.lastIndexOf(mark.fingerprint)
        if (idx < 0) continue
        holder.text = holder.text.slice(0, idx) + marker
        mark.fingerprint = '' // 已剪过的标记失效，防止未来误伤含同文本的 part
        seen.add(key)
        pruned += 1
      }
      return
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') walk(value)
    }
  }
  walk(messages)
  return pruned
}

/** 把指令追加进 system（兼容 string[] / {text}[] 两种形态）。 */
export function appendSystemHints(system: unknown, hints: string[]): void {
  if (hints.length === 0) return
  if (Array.isArray(system)) {
    for (const hint of hints) system.push({ type: 'text', text: hint })
  }
}

/**
 * context hook：每次模型请求组装前调用。
 * 1. messages 中按指纹截断中毒 part（模型视角的非破坏式剪枝）
 * 2. system 追加防复读/转向/放弃提示（各消费一次）
 * 3. options 施加温度扰动
 */
export function makeContextHook(
  cfg: Config,
  manager: RescueManager,
  i18n: Strings,
  log: (msg: string) => void,
) {
  return async (input: ContextInput): Promise<void> => {
    const directives = manager.consumeDirectives(input.sessionID)

    if (directives.poisoned.length) {
      const n = pruneMessages(input.messages, directives.poisoned, i18n.prunedMarker)
      if (n) log(`pruned ${n} poisoned part(s) session=${input.sessionID}`)
    }

    const hints: string[] = []
    if (cfg.keepLanguage && directives.guardHint) hints.push(directives.guardHint)
    if (directives.steerHint) hints.push(directives.steerHint)
    if (directives.giveUpHint) hints.push(directives.giveUpHint)
    if (hints.length) {
      appendSystemHints(input.system, hints)
      log(`injected ${hints.length} hint(s) session=${input.sessionID}`)
    }

    if (directives.temperatureBump > 0 && input.options && typeof input.options === 'object') {
      const options = input.options as Record<string, unknown>
      const current = typeof options.temperature === 'number' ? (options.temperature as number) : 0.6
      options.temperature = Math.min(1.5, current + directives.temperatureBump)
      log(`temperature bump -> ${options.temperature} session=${input.sessionID}`)
    }
  }
}
