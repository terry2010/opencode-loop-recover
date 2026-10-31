/** hooks.ts 单元测试：messages 指纹截断、system 注入、温度扰动 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneMessages, appendSystemHints, makeContextHook } from '../src/hooks.ts'
import { RescueManager } from '../src/rescue.ts'
import { resolveConfig } from '../src/config.ts'
import { strings } from '../src/i18n.ts'

const MARKER = '…[TRUNC]…'

test('pruneMessages: 命中指纹的 part 文本被截断', () => {
  const fingerprint = '重复单元abcdef重复单元ab'
  const text = `前缀内容${fingerprint}后续重复内容abcdef重复单元abcdef`
  const messages = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', parts: [{ type: 'text', text }] }]
  const n = pruneMessages(messages, [{ messageID: 'm1', ordinal: 0, fingerprint, kind: 'periodic', at: 0 }], MARKER)
  assert.equal(n, 1)
  const pruned = messages[1].parts[0].text
  assert.equal(pruned, '前缀内容' + MARKER)
  assert.ok(!pruned.includes('重复单元'))
})

test('pruneMessages: 指纹找不到不动', () => {
  const messages = [{ role: 'assistant', parts: [{ type: 'text', text: 'normal' }] }]
  const n = pruneMessages(messages, [{ messageID: 'm', ordinal: 0, fingerprint: 'zzz-no-match-zzz', kind: 'ngram', at: 0 }], MARKER)
  assert.equal(n, 0)
  assert.equal(messages[0].parts[0].text, 'normal')
})

test('pruneMessages: 同一指纹不重复截断', () => {
  const fp = 'XYZ'.repeat(20)
  const text = `a${fp}b${fp}c`
  const messages = [
    { role: 'assistant', parts: [{ type: 'text', text }] },
    { role: 'assistant', parts: [{ type: 'text', text: `副本${fp}` }] },
  ]
  const n = pruneMessages(messages, [{ messageID: 'm', ordinal: 0, fingerprint: fp, kind: 'ngram', at: 0 }], MARKER)
  assert.equal(n, 1) // 只截断第一处
})

test('pruneMessages: 嵌套结构兼容（content 数组/字符串字段）', () => {
  const fp = 'PATTERN-'.repeat(10)
  const messages = [
    { role: 'assistant', content: [{ type: 'output_text', text: `pre${fp}post` }] },
    { role: 'assistant', content: 'plain string' },
    { role: 'assistant', nested: { deep: [{ text: `x${fp}` }] } },
  ]
  const marks = [
    { messageID: 'm1', ordinal: 0, fingerprint: fp, kind: 'anchor', at: 0 },
    { messageID: 'm2', ordinal: 0, fingerprint: 'OTHER-' + 'q'.repeat(30), kind: 'anchor', at: 0 },
  ]
  const n = pruneMessages(messages, marks, MARKER)
  assert.equal(n, 1) // 只截断第一条命中的
})

test('appendSystemHints: 数组形态追加 {type,text}', () => {
  const system = [{ type: 'text', text: 'base' }]
  appendSystemHints(system, ['hint1', 'hint2'])
  assert.equal(system.length, 3)
  assert.deepEqual(system[1], { type: 'text', text: 'hint1' })
  assert.deepEqual(system[2], { type: 'text', text: 'hint2' })
})

test('appendSystemHints: 空 hints 不动', () => {
  const system = [{ type: 'text', text: 'base' }]
  appendSystemHints(system, [])
  assert.equal(system.length, 1)
})

test('makeContextHook: 完整管线——截断+hint+温度', async () => {
  const ops = { interrupt: async () => {}, prompt: async () => {}, waitIdle: async () => {}, log: () => {} }
  const cfg = resolveConfig({ temperatureBump: 0.4 })
  const m = new RescueManager(cfg, ops, 'en', strings('en'))
  // 直接种一个 poisoned + pending 状态
  const w = m.watch('s1')
  w.poisoned.push({ messageID: 'm1', ordinal: 0, fingerprint: 'LOOP-'.repeat(12), kind: 'periodic', at: 0 })
  w.guardHintPending = true
  w.temperatureBumpPending = true

  const hook = makeContextHook(cfg, m, strings('en'), () => {})
  const input = {
    sessionID: 's1',
    system: [],
    messages: [{ role: 'assistant', parts: [{ type: 'text', text: `ok ${'LOOP-'.repeat(12)}tail` }] }],
    options: { temperature: 0.6 },
  }
  await hook(input)
  assert.match(input.messages[0].parts[0].text, /^ok …\[loop-recover/)
  assert.equal(input.system.length, 1) // guardHint 注入
  assert.equal(input.options.temperature, 1.0) // 0.6+0.4
})

test('makeContextHook: 无 watch 的 session 不动任何东西', async () => {
  const ops = { interrupt: async () => {}, prompt: async () => {}, waitIdle: async () => {}, log: () => {} }
  const cfg = resolveConfig()
  const m = new RescueManager(cfg, ops, 'en', strings('en'))
  const hook = makeContextHook(cfg, m, strings('en'), () => {})
  const input = { sessionID: 'unknown', system: [], messages: [{ role: 'assistant', parts: [{ text: 'clean' }] }], options: {} }
  await hook(input)
  assert.equal(input.messages[0].parts[0].text, 'clean')
  assert.equal(input.system.length, 0)
  assert.equal(input.options.temperature, undefined)
})

test('makeContextHook: keepLanguage=false 时 guardHint 不注入', async () => {
  const ops = { interrupt: async () => {}, prompt: async () => {}, waitIdle: async () => {}, log: () => {} }
  const cfg = resolveConfig({ keepLanguage: false })
  const m = new RescueManager(cfg, ops, 'en', strings('en'))
  const w = m.watch('s1')
  w.guardHintPending = true
  const hook = makeContextHook(cfg, m, strings('en'), () => {})
  const input = { sessionID: 's1', system: [], messages: [], options: {} }
  await hook(input)
  assert.equal(input.system.length, 0)
})

test('makeContextHook: 温度封顶 1.5', async () => {
  const ops = { interrupt: async () => {}, prompt: async () => {}, waitIdle: async () => {}, log: () => {} }
  const cfg = resolveConfig({ temperatureBump: 1.0 })
  const m = new RescueManager(cfg, ops, 'en', strings('en'))
  m.watch('s1').temperatureBumpPending = true
  const hook = makeContextHook(cfg, m, strings('en'), () => {})
  const input = { sessionID: 's1', system: [], messages: [], options: { temperature: 1.2 } }
  await hook(input)
  assert.equal(input.options.temperature, 1.5)
})
