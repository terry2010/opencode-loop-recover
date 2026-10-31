/** config.ts 单元测试：options 合并、校验、默认值回落 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULT_CONFIG } from '../src/config.ts'

test('resolveConfig: 空 options 返回默认值', () => {
  const cfg = resolveConfig(undefined)
  assert.equal(cfg.mode, 'rescue')
  assert.equal(cfg.maxRescues, 3)
  assert.equal(cfg.bufferChars, 8192)
  assert.equal(cfg.keepLanguage, true)
  assert.equal(cfg.language, 'auto')
  assert.equal(cfg.debugLog, false)
  assert.deepEqual(cfg.detectors, { periodic: true, ngram: true, anchor: true, charrun: true, pool: true, intent: true })
})

test('resolveConfig: null/非对象输入不炸', () => {
  for (const raw of [null, 'x', 42, []]) {
    const cfg = resolveConfig(raw)
    assert.equal(cfg.mode, 'rescue')
  }
})

test('resolveConfig: mode 合法值生效，非法回落', () => {
  assert.equal(resolveConfig({ mode: 'cut' }).mode, 'cut')
  assert.equal(resolveConfig({ mode: 'observe' }).mode, 'observe')
  assert.equal(resolveConfig({ mode: 'bogus' }).mode, 'rescue')
})

test('resolveConfig: detectors 逐项开关', () => {
  const cfg = resolveConfig({ detectors: { pool: false, intent: false, periodic: true } })
  assert.equal(cfg.detectors.pool, false)
  assert.equal(cfg.detectors.intent, false)
  assert.equal(cfg.detectors.periodic, true)
  assert.equal(cfg.detectors.ngram, true)
})

test('resolveConfig: thresholds 传给检测器选项', () => {
  const cfg = resolveConfig({ thresholds: { ngramRepeats: 5, runMinChars: 32 } })
  assert.equal(cfg.detector.ngramRepeats, 5)
  assert.equal(cfg.detector.runMinChars, 32)
})

test('resolveConfig: intent 选项传递', () => {
  const cfg = resolveConfig({ intent: { toolPatterns: ['web_*', 'search*'], stallLimit: 3 } })
  assert.deepEqual(cfg.intent.toolPatterns, ['web_*', 'search*'])
  assert.equal(cfg.intent.stallLimit, 3)
})

test('resolveConfig: 数值边界', () => {
  assert.equal(resolveConfig({ maxRescues: 0 }).maxRescues, 3) // <1 回落
  assert.equal(resolveConfig({ maxRescues: 7 }).maxRescues, 7)
  assert.equal(resolveConfig({ bufferChars: 10 }).bufferChars, 8192) // <256 回落
  assert.equal(resolveConfig({ temperatureBump: -1 }).temperatureBump, 0.3)
  assert.equal(resolveConfig({ temperatureBump: 0 }).temperatureBump, 0)
})

test('resolveConfig: debugLog 字符串/布尔', () => {
  assert.equal(resolveConfig({ debugLog: '/tmp/x.log' }).debugLog, '/tmp/x.log')
  assert.equal(resolveConfig({ debugLog: true }).debugLog, false) // 非字符串非 false 回落
  assert.equal(resolveConfig({ debugLog: '  ' }).debugLog, false)
})

test('resolveConfig: language 三态', () => {
  assert.equal(resolveConfig({ language: 'zh' }).language, 'zh')
  assert.equal(resolveConfig({ language: 'en' }).language, 'en')
  assert.equal(resolveConfig({ language: 'auto' }).language, 'auto')
  assert.equal(resolveConfig({ language: 'fr' }).language, 'auto')
})

test('resolveConfig: 默认值不被输入污染', () => {
  resolveConfig({ detectors: { pool: false } })
  assert.equal(DEFAULT_CONFIG.detectors.pool, true)
})
