/**
 * opencode-loop-recover — 服务端入口。
 *
 * default export { id, setup }（Promise API），加载约定见
 * packages/core/src/plugin/module.ts 的 Module schema。
 */
import type { Plugin } from '@opencode/plugin'
import { resolveConfig } from './config.ts'
import { createLogger } from './log.ts'
import { resolveLanguage, strings } from './i18n.ts'
import { RescueManager, type RescueOps } from './rescue.ts'
import { BufferPool } from './buffer.ts'
import { makeContextHook } from './hooks.ts'
import { runWatch, WATCHED_TYPES, type EventLike } from './watch.ts'

interface SessionOpsLike {
  interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<unknown>
}

interface EventDomainLike {
  subscribe(input?: { types?: readonly string[] }): AsyncIterable<EventLike>
}

interface HookRegistrar {
  (name: string, callback: (input: never) => Promise<void>): Promise<{ dispose(): Promise<void> }>
}

interface CtxLike {
  options: Record<string, unknown>
  app: { name: string; version: string; channel: string }
  event: EventDomainLike
  session: SessionOpsLike & { hook: HookRegistrar }
}

const plugin: Plugin.Plugin = {
  id: 'loop-recover',

  setup: async (rawCtx) => {
    const ctx = rawCtx as unknown as CtxLike
    const cfg = resolveConfig(ctx.options)
    const log = createLogger(cfg.debugLog)
    const lang = resolveLanguage(cfg.language)
    const i18n = strings(lang)

    log(`setup mode=${cfg.mode} lang=${lang} app=${ctx.app.name}@${ctx.app.version}`)

    const ops: RescueOps = {
      interrupt: (sessionID) => ctx.session.interrupt({ sessionID }),
      prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
      waitIdle: async (sessionID) => {
        try {
          await ctx.session.wait({ sessionID })
        } catch (cause) {
          // wait 不可用时退化固定退避，仍然续跑
          log(`session.wait unavailable for ${sessionID}: ${cause}`)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      },
      log,
    }

    const manager = new RescueManager(cfg, ops, lang, i18n)
    const buffers = new BufferPool(cfg.bufferChars)

    const registrations: Array<{ dispose(): Promise<void> }> = []

    registrations.push(
      await ctx.session.hook('context', makeContextHook(cfg, manager, i18n, log) as never),
    )

    const abort = new AbortController()
    const events = ctx.event.subscribe({ types: [...WATCHED_TYPES] })
    const loop = runWatch({ events, cfg, manager, buffers, log }, abort.signal).catch((cause) =>
      log(`watch loop terminated: ${cause}`),
    )

    return async () => {
      abort.abort()
      await loop
      for (const reg of registrations) await reg.dispose().catch(() => {})
      log('disposed')
    }
  },
}

export default plugin
