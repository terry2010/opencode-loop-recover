/** 集成测试：mock ctx 全链路——setup→delta 事件→interrupt→context 清洗→prompt 续跑 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../src/server.ts'

function makeCtx(options = {}, eventSource) {
  const calls = { interrupt: [], prompt: [], wait: [], hooks: {}, subTypes: null }
  const hooks = {}
  const ctx = {
    options,
    app: { name: 'opencode', version: '2.1.4', channel: 'dev' },
    event: {
      subscribe(input = {}) {
        calls.subTypes = input.types
        return eventSource
      },
    },
    session: {
      interrupt: async (input) => { calls.interrupt.push(input) ; return { interrupted: true } },
      prompt: async (input) => { calls.prompt.push(input); return {} },
      wait: async (input) => { calls.wait.push(input) },
      hook: async (name, cb) => {
        hooks[name] = cb
        calls.hooks[name] = true
        return { dispose: async () => { delete hooks[name] } }
      },
    },
  }
  return { ctx, calls, hooks }
}

test('default export: {id, setup} 符合 Module schema', () => {
  assert.equal(plugin.id, 'loop-recover')
  assert.equal(typeof plugin.setup, 'function')
})

test('setup: 注册 context hook + 事件订阅，返回 cleanup', async () => {
  const events = {
    async *[Symbol.asyncIterator]() { /* 空流 */ },
  }
  const { ctx, calls, hooks } = makeCtx({ mode: 'rescue', debugLog: false, initDelayMs: 0 }, events)
  const cleanup = await plugin.setup(ctx)
  await new Promise((r) => setTimeout(r, 30)) // init 是后台任务
  assert.equal(typeof cleanup, 'function')
  assert.ok(calls.hooks.context, 'context hook 未注册')
  assert.deepEqual(calls.subTypes, [...(await import('../src/watch.ts')).WATCHED_TYPES])
  assert.equal(calls.subTypes.includes('session.text.delta'), true)
  await cleanup()
})

test('全链路：循环 delta → interrupt → wait → prompt → context 清洗', async () => {
  const loop = '死循环单元XYZ'.repeat(15)
  const events = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'session.text.delta', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: '正常前缀，内容是独特的。' }
      for (let i = 0; i < 6; i++) {
        yield { type: 'session.text.delta', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: loop }
      }
      // 事件流结束
      await new Promise((r) => setTimeout(r, 50))
    },
  }
  const { ctx, calls, hooks } = makeCtx({ mode: 'rescue', initDelayMs: 0 }, events)
  const cleanup = await plugin.setup(ctx)
  // 等事件循环跑完
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(calls.interrupt.length, 1, '应中断一次')
  assert.equal(calls.interrupt[0].sessionID, 's1')
  // resume：wait → prompt
  assert.equal(calls.wait.length, 1)
  assert.equal(calls.prompt.length, 1)
  assert.match(calls.prompt[0].text, /重复|循环|继续|loop|repetition|Continue/i)

  // context hook：模拟下一次模型请求组装，含中毒 part 的 messages
  const poisonedText = `正常前缀，内容是独特的。${loop}${loop}${loop}${loop}${loop}${loop}`
  const input = {
    sessionID: 's1',
    agent: 'build',
    model: {},
    system: [],
    messages: [{ role: 'assistant', parts: [{ type: 'text', text: poisonedText }] }],
    tools: {},
    options: { temperature: 0.6 },
  }
  await hooks.context(input)
  // 中毒尾部被截断
  assert.ok(input.messages[0].parts[0].text.length < poisonedText.length, 'part 应被截断')
  assert.match(input.messages[0].parts[0].text, /loop-recover/)
  // system 注入防复读约束（en——auto 无 locale 回落 en）
  assert.equal(input.system.length >= 1, true)
  // 温度扰动
  assert.ok(input.options.temperature > 0.6)
  await cleanup()
})

test('observe 模式：全链路不干预', async () => {
  const loop = '重复内容abc'.repeat(15)
  const events = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 8; i++) {
        yield { type: 'session.text.delta', sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, delta: loop }
      }
    },
  }
  const { ctx, calls } = makeCtx({ mode: 'observe', initDelayMs: 0 }, events)
  const cleanup = await plugin.setup(ctx)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls.interrupt.length, 0)
  assert.equal(calls.prompt.length, 0)
  await cleanup()
})
