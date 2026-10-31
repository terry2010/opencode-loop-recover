import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchPluginOptions, mergeOptions, isOwnSpec, PACKAGE_NAME } from '../src/gui/config-patch.ts'

test('isOwnSpec 识别本包的各种 spec 形式', () => {
  assert.equal(isOwnSpec(PACKAGE_NAME), true)
  assert.equal(isOwnSpec(`${PACKAGE_NAME}@0.1.0`), true)
  assert.equal(isOwnSpec(`file:///home/u/code/${PACKAGE_NAME}`), true)
  assert.equal(isOwnSpec(`/abs/path/${PACKAGE_NAME}`), true)
  assert.equal(isOwnSpec(`/abs/path/${PACKAGE_NAME}/`), true)
  // 形如 "-pkg" 的是卸载指令，不是本包 entry
  assert.equal(isOwnSpec(`-${PACKAGE_NAME}`), false)
  assert.equal(isOwnSpec('other-plugin'), false)
  assert.equal(isOwnSpec('opencode-loop-recover-extra'), false)
  assert.equal(isOwnSpec(42), false)
  assert.equal(isOwnSpec(undefined), false)
})

test('字符串 entry 升级为 { package, options }，其他 entry 不动', () => {
  const input = '{\n  "plugins": ["other-pkg", "opencode-loop-recover"]\n}\n'
  const out = patchPluginOptions(input, { mode: 'observe' })
  const cfg = JSON.parse(out)
  assert.equal(cfg.plugins[0], 'other-pkg')
  assert.deepEqual(cfg.plugins[1], { package: PACKAGE_NAME, options: { mode: 'observe' } })
})

test('对象 entry 合并 options 并保留 entry 其他字段', () => {
  const input = JSON.stringify({
    plugins: [{ package: PACKAGE_NAME, options: { mode: 'cut' }, note: 'keep' }],
  })
  const cfg = JSON.parse(patchPluginOptions(input, { maxRescues: 5, mode: 'rescue' }))
  assert.deepEqual(cfg.plugins[0], {
    package: PACKAGE_NAME,
    options: { mode: 'rescue', maxRescues: 5 },
    note: 'keep',
  })
})

test('嵌套对象按一级浅合并，未提及的键保留', () => {
  const merged = mergeOptions({ thresholds: { minPeriod: 8, maxPeriod: 256 }, mode: 'cut' }, { thresholds: { minPeriod: 4 } })
  assert.deepEqual(merged, { thresholds: { minPeriod: 4, maxPeriod: 256 }, mode: 'cut' })
})

test('patch 值为 null 删除该键；清空后空嵌套对象一并删除', () => {
  assert.deepEqual(mergeOptions({ debugLog: '/tmp/x', mode: 'cut' }, { debugLog: null }), { mode: 'cut' })
  assert.deepEqual(mergeOptions({ thresholds: { minPeriod: 4 } }, { thresholds: { minPeriod: null } }), {})
  assert.deepEqual(mergeOptions({ detectors: { pool: false } }, { detectors: { pool: null, ngram: false } }), {
    detectors: { ngram: false },
  })
})

test('插件未列出时追加对象 entry', () => {
  const cfg = JSON.parse(patchPluginOptions('{"plugins": ["other-pkg"]}', { mode: 'cut' }))
  assert.deepEqual(cfg.plugins, ['other-pkg', { package: PACKAGE_NAME, options: { mode: 'cut' } }])
})

test('plugins 字段缺失时新建', () => {
  const cfg = JSON.parse(patchPluginOptions('{"model": "x"}', { keepLanguage: false }))
  assert.deepEqual(cfg.plugins, [{ package: PACKAGE_NAME, options: { keepLanguage: false } }])
  assert.equal(cfg.model, 'x')
})

test('卸载指令 entry 不算本包 entry，仍追加配置 entry', () => {
  const cfg = JSON.parse(patchPluginOptions(`{"plugins": ["-${PACKAGE_NAME}"]}`, { mode: 'cut' }))
  assert.deepEqual(cfg.plugins, [`-${PACKAGE_NAME}`, { package: PACKAGE_NAME, options: { mode: 'cut' } }])
})

test('JSONC 注释保留在文件里', () => {
  const input = '// top comment\n{\n  "plugins": ["opencode-loop-recover"], // tail\n}\n'
  const out = patchPluginOptions(input, { mode: 'observe' })
  assert.match(out, /top comment/)
  assert.match(out, /tail/)
  assert.match(out, /"mode": "observe"/)
})

test('非法输入抛错而不是写坏文件', () => {
  assert.throws(() => patchPluginOptions('{oops', { a: 1 }))
  assert.throws(() => patchPluginOptions('{"plugins": {}}', { a: 1 }))
  assert.throws(() => patchPluginOptions('[1,2]', { a: 1 }))
})

test('空文档 {} 也可起步', () => {
  const cfg = JSON.parse(patchPluginOptions('{}', { mode: 'rescue' }))
  assert.deepEqual(cfg.plugins, [{ package: PACKAGE_NAME, options: { mode: 'rescue' } }])
})
