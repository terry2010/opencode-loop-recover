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

  // signal 只能在下一条事件到达后生效——事件源挂起时 for-await 挂起是预期行为
  for await (const event of events) {
    if (signal?.aborted) return
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
            await manager.onStreamText(p.sessionID, p.assistantMessageID, p.ordinal, buf.text())
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
}
