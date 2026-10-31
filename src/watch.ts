import type { Config } from './config.ts'
import type { RescueManager } from './rescue.ts'
import { BufferPool } from './buffer.ts'

export interface EventLike {
  type: string
  [key: string]: unknown
}

export interface WatchDeps {
  /** ctx.event.subscribe 返回的 AsyncIterable（或 Stream 适配后的可迭代对象） */
  events: AsyncIterable<EventLike>
  /** 本插件实例所在 location（ctx.directory）。事件流是全局的：不匹配的事件跳过，
   * 否则多 location 场景同一事件会被各实例并行救援（同一 session 被重复 interrupt/resume）。 */
  directory?: string
  cfg: Config
  manager: RescueManager
  buffers: BufferPool
  log: (msg: string) => void
}

/** 本插件关心的事件类型。 */
export const WATCHED_TYPES = [
  'session.text.delta',
  'session.reasoning.delta',
  'session.text.ended',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.called',
  'session.deleted',
] as const

interface DeltaPayload {
  sessionID: string
  assistantMessageID: string
  ordinal: number
  delta: string
}

interface EndedPayload {
  sessionID: string
  assistantMessageID: string
  ordinal: number
}

interface ToolInputStartedPayload {
  sessionID: string
  id: string
  name: string
}

interface ToolCalledPayload {
  sessionID: string
  id: string
  input: Record<string, unknown>
}

/**
 * 事件分发主循环。由 setup 里以 AbortSignal 控制生命周期。
 * tool.called 的载荷里没有工具名，需借 tool.input.started 的 name 按 id 关联。
 */
export async function runWatch(deps: WatchDeps, signal?: AbortSignal): Promise<void> {
  const { events, manager, buffers, log } = deps
  const toolNames = new Map<string, string>()
  const seenTypes = new Set<string>()

  // 挂起的 next() 不会被 abort 唤醒：插件重载时 cleanup 等待本函数返回，
  // 手动竞速保证 teardown 可完成，否则激活会永久卡死。
  const iterator = events[Symbol.asyncIterator]()
  const aborted = signal
    ? new Promise<IteratorResult<EventLike>>((resolve) => {
        if (signal.aborted) resolve({ done: true, value: undefined })
        else signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
      })
    : undefined
  try {
    for (;;) {
      const step = aborted ? await Promise.race([iterator.next(), aborted]) : await iterator.next()
      if (step.done) return
      const event = step.value
      const eventDir = (event as { location?: { directory?: string } }).location?.directory
      if (deps.directory && eventDir && eventDir !== deps.directory) continue
      if (!seenTypes.has(event.type)) {
        seenTypes.add(event.type)
        const data = (event.data ?? event) as Record<string, unknown>
        log(`first event type=${event.type} keys=${Object.keys(data).join(',')} delta=${JSON.stringify(data.delta)?.slice(0, 60)}`)
      }
      // 事件信封：{id, created, type, location?, data}——业务字段在 data 里
      const data = (event.data ?? event) as Record<string, unknown>
      try {
        switch (event.type) {
          case 'session.text.delta':
          case 'session.reasoning.delta': {
            const p = data as unknown as DeltaPayload
            const buf = buffers.get(p.sessionID, p.assistantMessageID, p.ordinal)
            buf.append(p.delta)
            if (buf.needsCheck()) {
              const stream = event.type === 'session.reasoning.delta' ? 'reasoning' : 'text'
              await manager.onStreamText(p.sessionID, p.assistantMessageID, p.ordinal, buf.text(), stream)
            }
            break
          }
          case 'session.text.ended':
          case 'session.reasoning.ended': {
            const p = data as unknown as EndedPayload
            buffers.drop(p.sessionID, p.assistantMessageID, p.ordinal)
            break
          }
          case 'session.tool.input.started': {
            const p = data as unknown as ToolInputStartedPayload
            toolNames.set(`${p.sessionID}:${p.id}`, p.name)
            break
          }
          case 'session.tool.called': {
            const p = data as unknown as ToolCalledPayload
            const name = toolNames.get(`${p.sessionID}:${p.id}`) ?? 'unknown'
            manager.onToolCall(p.sessionID, name, p.input)
            break
          }
          case 'session.deleted': {
            const p = data as unknown as { sessionID: string }
            manager.drop(p.sessionID)
            buffers.dropSession(p.sessionID)
            log(`watch dropped session=${p.sessionID}`)
            break
          }
        }
      } catch (cause) {
        log(`event dispatch error type=${event.type}: ${cause}`)
      }
    }
  } finally {
    await iterator.return?.().catch(() => {})
  }
}
