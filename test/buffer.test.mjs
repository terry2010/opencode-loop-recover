/** buffer.ts 单元测试：滚动窗口、摊销检查、池化管理 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RollingBuffer, BufferPool } from '../src/buffer.ts'

test('RollingBuffer: 追加与文本读取', () => {
  const b = new RollingBuffer(100)
  b.append('abc')
  b.append('def')
  assert.equal(b.text(), 'abcdef')
  assert.equal(b.length, 6)
})

test('RollingBuffer: 超窗截尾', () => {
  const b = new RollingBuffer(10)
  b.append('x'.repeat(20))
  assert.equal(b.length, 10)
  assert.equal(b.text(), 'x'.repeat(10))
  b.append('yyyyy')
  assert.equal(b.text(), 'x'.repeat(5) + 'y'.repeat(5))
})

test('RollingBuffer: needsCheck 摊销——短文本不查', () => {
  const b = new RollingBuffer(8192, 32, 256)
  b.append('a'.repeat(100))
  assert.equal(b.needsCheck(), false)
  b.append('a'.repeat(200)) // 累计 300 ≥ 256
  assert.equal(b.needsCheck(), true)
  assert.equal(b.needsCheck(), false) // 刚查过，未到下一间隔
})

test('RollingBuffer: needsCheck 按 checkEvery 间隔', () => {
  const b = new RollingBuffer(8192, 32, 64)
  b.append('a'.repeat(64))
  assert.equal(b.needsCheck(), true)
  b.append('a'.repeat(10)) // +10 < 32
  assert.equal(b.needsCheck(), false)
  b.append('a'.repeat(30)) // 累计 104 ≥ 下一检查点 96
  assert.equal(b.needsCheck(), true)
})

test('BufferPool: 同 key 共享缓冲，不同 key 隔离', () => {
  const pool = new BufferPool(1000)
  const a = pool.get('s1', 'm1', 0)
  const b = pool.get('s1', 'm1', 0)
  const c = pool.get('s1', 'm1', 1)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('BufferPool: drop 单个 part', () => {
  const pool = new BufferPool(1000)
  const before = pool.get('s1', 'm1', 0)
  before.append('data')
  pool.drop('s1', 'm1', 0)
  const after = pool.get('s1', 'm1', 0)
  assert.equal(after.length, 0)
  assert.notEqual(before, after)
})

test('BufferPool: dropSession 只清该 session', () => {
  const pool = new BufferPool(1000)
  pool.get('s1', 'm1', 0).append('x')
  pool.get('s1', 'm2', 0).append('x')
  pool.get('s2', 'm1', 0).append('x')
  pool.dropSession('s1')
  assert.equal(pool.get('s1', 'm1', 0).length, 0)
  assert.equal(pool.get('s2', 'm1', 0).length, 1)
})

test('BufferPool.key: 组合格式', () => {
  assert.equal(BufferPool.key('s', 'm', 3), 's:m:3')
})
