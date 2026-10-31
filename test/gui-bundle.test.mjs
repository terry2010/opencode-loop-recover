import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { Host } from '@opencode/plugin/host'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundlePath = join(root, 'dist', 'gui-experimental.cjs')

/** 桌面宿主提供给插件 bundle 的模块（window + main + shared）。 */
const PROVIDED = new Set([
  'effect',
  '@opencode/plugin/gui',
  '@opencode/plugin/gui/main',
  '@opencode/plugin/rpc',
  '@opencode/schema/rpc',
  '@opencode/client',
  '@opencode/client/effect',
  '@opencode/client/solid',
  '@opencode/plugin/gui/file',
  '@opencode/plugin/gui/review',
  '@opencode/plugin/gui/browser',
  'electron',
  'solid-js',
  'solid-js/web',
  'solid-js/store',
])

// 桌面宿主为对端进程模块注入 inert placeholder：任意属性读取/调用/构造都可放行。
const anything = new Proxy(function () {}, {
  get: (target, prop) => (typeof prop === 'symbol' ? undefined : anything),
  apply: () => anything,
  construct: () => anything,
})

/**
 * 模拟宿主 evaluatePluginBundle：CJS 文本 + 模块注册表。
 * node:* 返回真实模块（main 进程真实可用），其余 provided 模块给 placeholder。
 */
function evaluateBundle() {
  const guiStub = new Proxy(
    {
      Plugin: { define: (definition) => definition },
      Ipc: { define: (spec) => ({ kind: 'ipc', ...spec }) },
      SettingsPage: { kind: 'registry' },
    },
    { get: (target, prop) => (prop in target ? target[prop] : anything) },
  )
  const require = createRequire(import.meta.url)
  const moduleObj = { exports: {} }
  new Function('module', 'exports', 'require', readFileSync(bundlePath, 'utf8'))(
    moduleObj,
    moduleObj.exports,
    (id) => {
      if (id === '@opencode/plugin/gui') return guiStub
      if (id.startsWith('node:')) return require(id)
      return anything
    },
  )
  return moduleObj.exports.default
}

test('Host.resolve 把包识别为带 server + gui 入口', () => {
  const entrypoints = Host.resolve({ directory: root })
  assert.ok(entrypoints.server?.endsWith('dist/server.js'), `server: ${entrypoints.server}`)
  assert.ok(entrypoints.gui?.endsWith('dist/gui-experimental.cjs'), `gui: ${entrypoints.gui}`)
})

test('bundle 的外部 require 全部是宿主提供的模块', () => {
  const code = readFileSync(bundlePath, 'utf8')
  const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
  assert.ok(required.length > 0, 'bundle 应有外部 require')
  for (const id of new Set(required)) {
    assert.ok(PROVIDED.has(id) || id.startsWith('node:'), `bundle 引用了宿主不提供的模块: ${id}`)
  }
})

test('bundle 按 CJS 评估后 default export 是带 setup 和 main 的 Plugin.define', () => {
  const definition = evaluateBundle()
  assert.equal(typeof definition?.setup, 'function', 'setup 缺失')
  assert.equal(typeof definition?.main, 'function', 'main 缺失')
  assert.equal(definition.i18n?.en?.['settings.title'], 'Loop Recover')
  assert.ok(definition.i18n?.zh?.['section.basics'], '中文 i18n 缺失')
})

test('main 的 setOptions 真实写回全局配置文件（路径解析 + 保注释补丁 + 原子写）', async () => {
  const definition = evaluateBundle()
  let impl
  definition.main({
    provide: (token, i) => {
      impl = i
    },
    log: { write() {} },
  })
  assert.ok(impl?.setOptions, 'ConfigIpc 未被 provide')

  const dir = mkdtempSync(join(tmpdir(), 'lr-cfg-'))
  const file = join(dir, 'opencode.json')
  writeFileSync(file, '{\n  // user comment\n  "plugins": ["opencode-loop-recover"]\n}\n')

  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    assert.equal(await impl.configPath(), file)
    // getOptions 读到文件里的真值
    assert.deepEqual(await impl.getOptions(), {})
    await impl.setOptions({ mode: 'observe', thresholds: { minPeriod: 4 } })
    // 写后读回路：getOptions 应返回刚写入的 options
    assert.deepEqual(await impl.getOptions(), { mode: 'observe', thresholds: { minPeriod: 4 } })
  } finally {
    delete process.env.OPENCODE_CONFIG_DIR
  }

  const text = readFileSync(file, 'utf8')
  assert.match(text, /user comment/, '注释应保留')
  assert.match(text, /"mode": "observe"/)
  assert.match(text, /"minPeriod": 4/)
})
