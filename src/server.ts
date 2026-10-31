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

    const abort = new AbortController()
    const registrations: Array<{ dispose(): Promise<void> }> = []

    // 关键：冷启动期完全"装死"——setup 立即返回，所有宿主 API 调用推迟到激活稳定后。
    // 激活期订阅可能回放积压事件并阻塞 fiber（/api/model 全 503 的根因猜测）。
    const init = (async () => {
      const delay = typeof ctx.options?.initDelayMs === 'number' ? ctx.options.initDelayMs : 3000
      await new Promise((r) => setTimeout(r, delay))
      if (abort.signal.aborted) return
      log('init: registering context hook')
      const reg = await Promise.race([
        ctx.session.hook('context', makeContextHook(cfg, manager, i18n, log) as never),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hook registration timeout')), 10000)),
      ])
      registrations.push(reg)
      log('init: context hook registered')

      log('init: subscribing events')
      const events = ctx.event.subscribe({ types: [...WATCHED_TYPES] })
      await runWatch({ events, cfg, manager, buffers, log }, abort.signal)
      log('init: event stream ended')
    })().catch((cause) => log(`init failed: ${cause}`))

    return async () => {
      abort.abort()
      await init
      for (const reg of registrations) await reg.dispose().catch(() => {})
      log('disposed')
    }
  },
}

export default plugin
