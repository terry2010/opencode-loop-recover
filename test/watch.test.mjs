/** watch.ts 单元测试：事件分发、缓冲喂入、工具名关联、session 清理 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWatch, WATCHED_TYPES } from '../src/watch.ts'
import { RescueManager } from '../src/rescue.ts'
import { BufferPool } from '../src/buffer.ts'
import { resolveConfig } from '../src/config.ts'
import { strings } from '../src/i18n.ts'

function makeDeps(cfg = resolveConfig()) {
  const calls = { interrupt: [], prompt: [], waitIdle: [], log: [] }
  const ops = {
    interrupt: async (sid) => { calls.interrupt.push(sid) },
    prompt: async (sid, text) => { calls.prompt.push({ sid, text }) },
    waitIdle: async (sid) => { calls.waitIdle.push(sid) },
    log: (msg) => calls.log.push(msg),
  }
  const manager = new RescueManager(cfg, ops, 'zh', strings('zh'))
  const buffers = new BufferPool(8192, 4, 8) // 小阈值便于测试
  return { calls, manager, buffers, cfg, log: ops.log }
}

async function* gen(events) {
  for (const e of events) yield e
}

const delta = (sid, mid, ord, text) => ({ type: 'session.text.delta', sessionID: sid, assistantMessageID: mid, ordinal: ord, delta: text })

test('WATCHED_TYPES: 订阅清单含必需事件', () => {
  for (const t of ['session.text.delta', 'session.reasoning.delta', 'session.tool.called', 'session.deleted']) {
    assert.ok(WATCHED_TYPES.includes(t), `missing ${t}`)
  }
})

test('runWatch: delta 喂入缓冲并触发检测', async () => {
  const d = makeDeps()
  const loop = '复读单元X'.repeat(20)
  const events = gen([
    delta('s1', 'm1', 0, '正常前缀。'),
    delta('s1', 'm1', 0, loop),
    delta('s1', 'm1', 0, loop),
    delta('s1', 'm1', 0, loop),
    delta('s1', 'm1', 0, loop),
  ])
  await runWatch({ events, ...d }, undefined)
  assert.equal(d.calls.interrupt.length, 1)
  assert.equal(d.calls.interrupt[0], 's1')
})

test('runWatch: 正常文本不触发', async () => {
  const d = makeDeps()
  const events = gen([
    delta('s1', 'm1', 0, '这是一段完全正常的输出，内容每次都不同。'),
    delta('s1', 'm1', 0, '继续生成不一样的内容，没有任何重复模式。'),
  ])
  await runWatch({ events, ...d }, undefined)
  assert.equal(d.calls.interrupt.length, 0)
})

test('runWatch: part 结束释放缓冲', async () => {
  const d = makeDeps()
  const events = gen([
    delta('s1', 'm1', 0, '内容'),
    { type: 'session.text.ended', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, text: '内容' },
  ])
  await runWatch({ events, ...d }, undefined)
  // 缓冲已释放：再 get 是新的
  assert.equal(d.buffers.get('s1', 'm1', 0).length, 0)
})

test('runWatch: 工具名按 id 关联（input.started → called）', async () => {
  const d = makeDeps(resolveConfig({ intent: { toolPatterns: ['web_*'], stallLimit: 1, noveltyThreshold: 0.99, similarityThreshold: 0.2 } }))
  const events = gen([
    { type: 'session.tool.input.started', sessionID: 's1', id: 'call_1', name: 'web_search' },
    { type: 'session.tool.called', sessionID: 's1', id: 'call_1', input: { query: 'topic alpha' } },
    { type: 'session.tool.called', sessionID: 's1', id: 'call_1', input: { query: 'topic alpha' } },
  ])
  await runWatch({ events, ...d }, undefined)
  assert.equal(d.manager.peek('s1').steerPending, true)
  assert.ok(d.calls.log.some((l) => l.includes('web_search')))
})

test('runWatch: 未知名字工具走 unknown（不通配不匹配）', async () => {
  const d = makeDeps(resolveConfig({ intent: { toolPatterns: ['web_*'] } }))
  const events = gen([
    { type: 'session.tool.called', sessionID: 's1', id: 'call_9', input: { query: 'x' } },
  ])
  await runWatch({ events, ...d }, undefined)
  assert.equal(d.manager.peek('s1')?.steerPending ?? false, false)
})

test('runWatch: session.deleted 清理状态', async () => {
  const d = makeDeps()
  const events = gen([
    delta('s1', 'm1', 0, 'abc'),
    { type: 'session.deleted', sessionID: 's1' },
  ])
  await runWatch({ events, ...d }, undefined)
  assert.equal(d.manager.peek('s1'), undefined)
})

test('runWatch: 单事件异常不中断循环', async () => {
  const d = makeDeps()
  // 畸形事件（缺字段）夹在正常事件之间
  const events = gen([
    { type: 'session.text.delta' }, // 缺 sessionID 等 → dispatch 内部容错
    delta('s1', 'm1', 0, '正常'),
  ])
  await runWatch({ events, ...d }, undefined) // 不抛即过
})

test('runWatch: 非本 location 的事件被跳过（多实例并行救援防护）', async () => {
  const d = makeDeps()
  let calls = 0
  d.manager.onStreamText = async () => { calls++ }
  const foreign = (text) => ({ type: 'session.text.delta', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: text, location: { directory: '/other/workspace' } })
  const mine = (text) => ({ type: 'session.text.delta', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: text, location: { directory: '/my/workspace' } })
  const events = {
    async *[Symbol.asyncIterator]() {
      yield foreign('a'.repeat(600)) // 别 location 的循环事件——必须被跳过
      yield mine('b') // 本 location 的——正常处理
    },
  }
  await runWatch({ events, directory: '/my/workspace', ...d }, undefined)
  assert.equal(calls, 0) // foreign 的 600 字节重复未触发检测；mine 太短也不触发
  assert.ok(d.buffers.get('s1', 'm1', 0).text().endsWith('b'))
})

test('runWatch: abort 唤醒挂起的 next()，teardown 可完成', async () => {
  const d = makeDeps()
  const ac = new AbortController()
  let returned = false
  const events = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}), // 事件源永久挂起，不响应 abort
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  const done = runWatch({ events, ...d }, ac.signal)
  ac.abort()
  // 契约：cleanup 等待 runWatch 返回；挂起的事件源不得阻塞 teardown，
  // 否则插件激活会永久卡死（真机事故）。
  await done
  assert.equal(returned, true)
})
