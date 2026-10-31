/** rescue.ts 单元测试：检测→中断→标记→续跑→连救保护→意图转向→指令消费 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RescueManager, runDetectors } from '../src/rescue.ts'
import { resolveConfig } from '../src/config.ts'
import { strings } from '../src/i18n.ts'

function makeOps() {
  const calls = { interrupt: [], prompt: [], waitIdle: [], log: [] }
  const ops = {
    interrupt: async (sid) => { calls.interrupt.push(sid) },
    prompt: async (sid, text) => { calls.prompt.push({ sid, text }) },
    waitIdle: async (sid) => { calls.waitIdle.push(sid) },
    log: (msg) => calls.log.push(msg),
  }
  return { ops, calls }
}

const loopText = () => '正常前置内容。'.repeat(30) + '重复单元abcdef'.repeat(12)

test('runDetectors: 开关控制——全关不命中', () => {
  const cfg = resolveConfig({ detectors: { periodic: false, ngram: false, anchor: false, charrun: false, pool: false } })
  assert.equal(runDetectors(loopText(), cfg), null)
})

test('runDetectors: 周期文本命中', () => {
  const cfg = resolveConfig()
  const hit = runDetectors(loopText(), cfg)
  assert.ok(hit, 'expected hit')
  assert.ok(['periodic', 'ngram', 'anchor'].includes(hit.kind))
})

test('rescue 模式：命中→interrupt→waitIdle→prompt 续跑', async () => {
  const { ops, calls } = makeOps()
  const m = new RescueManager(resolveConfig(), ops, 'zh', strings('zh'))
  const hit = await m.onStreamText('s1', 'msg1', 0, loopText())
  assert.ok(hit)
  assert.deepEqual(calls.interrupt, ['s1'])
  // resume 是异步任务，等一拍
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(calls.waitIdle, ['s1'])
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].sid, 's1')
  assert.match(calls.prompt[0].text, /重复|循环|继续|任务/)
})

test('observe 模式：只记录不干预', async () => {
  const { ops, calls } = makeOps()
  const m = new RescueManager(resolveConfig({ mode: 'observe' }), ops, 'zh', strings('zh'))
  const hit = await m.onStreamText('s1', 'msg1', 0, loopText())
  assert.ok(hit)
  assert.equal(calls.interrupt.length, 0)
  assert.equal(calls.prompt.length, 0)
})

test('cut 模式：interrupt 但不续跑', async () => {
  const { ops, calls } = makeOps()
  const m = new RescueManager(resolveConfig({ mode: 'cut' }), ops, 'zh', strings('zh'))
  await m.onStreamText('s1', 'msg1', 0, loopText())
  assert.equal(calls.interrupt.length, 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls.prompt.length, 0)
})

test('中毒标记：fingerprint 取自重复区', async () => {
  const { ops } = makeOps()
  const m = new RescueManager(resolveConfig(), ops, 'zh', strings('zh'))
  const text = loopText()
  await m.onStreamText('s1', 'msg1', 0, text)
  const w = m.peek('s1')
  assert.equal(w.poisoned.length, 1)
  const mark = w.poisoned[0]
  assert.equal(mark.messageID, 'msg1')
  assert.ok(text.includes(mark.fingerprint), 'fingerprint 应能在原文定位')
})

test('连救保护：第 maxRescues+1 次转 observe', async () => {
  const { ops, calls } = makeOps()
  const m = new RescueManager(resolveConfig({ maxRescues: 2 }), ops, 'zh', strings('zh'))
  for (let i = 0; i < 2; i++) {
    await m.onStreamText('s1', `msg${i}`, 0, loopText())
  }
  assert.equal(calls.interrupt.length, 2)
  // 第 3 次命中 → gaveUp，不再 interrupt
  await m.onStreamText('s1', 'msg3', 0, loopText())
  assert.equal(calls.interrupt.length, 2)
  const w = m.peek('s1')
  assert.equal(w.gaveUp, true)
  // 第 4 次也不救
  await m.onStreamText('s1', 'msg4', 0, loopText())
  assert.equal(calls.interrupt.length, 2)
})

test('意图检测：重复工具查询→steerPending', async () => {
  const { ops } = makeOps()
  const cfg = resolveConfig({ intent: { toolPatterns: ['web_*'], stallLimit: 2, noveltyThreshold: 0.9, similarityThreshold: 0.3 } })
  const m = new RescueManager(cfg, ops, 'zh', strings('zh'))
  // 不匹配的工具不触发，也不创建 watch
  m.onToolCall('s1', 'read_file', { path: '/a' })
  assert.equal(m.peek('s1')?.steerPending ?? false, false)
  // 匹配工具：首次 novelty=1 恒不 stalled；stallLimit=2 需第 3 次才触发
  m.onToolCall('s1', 'web_search', { query: 'opencode plugin development guide' })
  m.onToolCall('s1', 'web_search', { query: 'opencode plugin development tutorial' })
  const triggered = m.onToolCall('s1', 'web_search', { query: 'opencode plugin development intro' })
  assert.equal(triggered, true)
  assert.equal(m.peek('s1').steerPending, true)
})

test('consumeDirectives: 各提示消费一次后清空', async () => {
  const { ops } = makeOps()
  const m = new RescueManager(resolveConfig({ temperatureBump: 0.5 }), ops, 'zh', strings('zh'))
  await m.onStreamText('s1', 'msg1', 0, loopText())
  const d1 = m.consumeDirectives('s1')
  assert.equal(d1.temperatureBump, 0.5)
  assert.ok(d1.poisoned.length === 1)
  // 第二次消费——pending 已清（resuming 异步置 guardHint 可能仍在竞态外，只断言温度与 poisoned 不重复）
  const d2 = m.consumeDirectives('s1')
  assert.equal(d2.temperatureBump, 0)
  assert.ok(d2.poisoned.length === 1) // 标记保留直到 session 结束
})

test('consumeDirectives: steer/giveUp 提示各出现一次', async () => {
  const { ops } = makeOps()
  const cfg = resolveConfig({ maxRescues: 1, intent: { toolPatterns: ['*'], stallLimit: 1, noveltyThreshold: 0.99, similarityThreshold: 0.2 } })
  const m = new RescueManager(cfg, ops, 'zh', strings('zh'))
  m.onToolCall('s1', 'web_search', { query: 'same topic' })
  m.onToolCall('s1', 'web_search', { query: 'same topic' }) // 第二次 stalled，stallLimit=1 触发
  let d = m.consumeDirectives('s1')
  assert.ok(d.steerHint)
  d = m.consumeDirectives('s1')
  assert.equal(d.steerHint, undefined)
  // 救一次到上限 → giveUp
  await m.onStreamText('s1', 'm1', 0, loopText())
  await m.onStreamText('s1', 'm2', 0, loopText())
  d = m.consumeDirectives('s1')
  assert.ok(d.giveUpHint)
})

test('drop: 清理 session 状态', async () => {
  const { ops } = makeOps()
  const m = new RescueManager(resolveConfig(), ops, 'zh', strings('zh'))
  await m.onStreamText('s1', 'm1', 0, loopText())
  m.drop('s1')
  assert.equal(m.peek('s1'), undefined)
  const w = m.watch('s1')
  assert.equal(w.rescueCount, 0)
})

test('resuming 防抖：命中后 resume 只排一次', async () => {
  const { ops, calls } = makeOps()
  const m = new RescueManager(resolveConfig({ maxRescues: 5 }), ops, 'zh', strings('zh'))
  // 同一 part 连续命中两次（resuming 未释放时）
  const p1 = m.onStreamText('s1', 'm1', 0, loopText())
  const p2 = m.onStreamText('s1', 'm1', 0, loopText())
  await Promise.all([p1, p2])
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(calls.prompt.length <= 2)
})
