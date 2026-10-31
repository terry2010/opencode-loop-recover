/**
 * opencode-loop-recover — 全局配置文件补丁（纯函数，可离线单测）。
 *
 * GUI 设置页把插件 options 写回全局 opencode.json(c)：entry 从字符串形式
 * "opencode-loop-recover" 升级为 { package, options } 对象形式。
 * 用 jsonc-parser 的 modify/applyEdits 做保注释编辑（与 `opencode plugin add` 同款写法），
 * 写回后 opencode 的 config watcher 自动重载 server 与 GUI 插件，ctx.options 保持单一数据源。
 */
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'

/** npm 包名；`plugin add` 写进配置的就是它。 */
export const PACKAGE_NAME = 'opencode-loop-recover'

/**
 * 一个 plugins entry 指向本包吗？
 * 匹配：裸包名、带版本包名（name@1.2.3）、file:// 或绝对路径（按目录 basename 匹配，覆盖本地开发）。
 */
export function isOwnSpec(spec: unknown): boolean {
  if (typeof spec !== 'string' || !spec || spec.startsWith('-')) return false
  if (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`)) return true
  const file = spec.startsWith('file://') ? spec.slice('file://'.length) : spec
  const base = file.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()
  return base === PACKAGE_NAME
}

function entrySpec(entry: unknown): unknown {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return (entry as Record<string, unknown>).package
  return undefined
}

function entryOptions(entry: unknown): Record<string, unknown> {
  if (entry && typeof entry === 'object') {
    const options = (entry as Record<string, unknown>).options
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      return options as Record<string, unknown>
    }
  }
  return {}
}

/**
 * 把 patch 合并进 options：嵌套对象（detectors/thresholds/intent）按一级浅合并；
 * 值为 null 的键表示"删除该项、回落默认"；清空后的空嵌套对象一并删除。
 */
export function mergeOptions(
  options: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...options }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const existing = out[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      const nested = mergeOptions(existing as Record<string, unknown>, value as Record<string, unknown>)
      if (Object.keys(nested).length === 0) delete out[key]
      else out[key] = nested
      continue
    }
    out[key] = value
  }
  return out
}

/** 从配置文件文本读出本插件当前的 options；文档非法或没有本包 entry 时返回 {}。 */
export function readPluginOptions(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== 'object' || config === null || Array.isArray(config)) return {}
  const plugins = (config as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) return {}
  const entry = plugins.find((item) => isOwnSpec(entrySpec(item)))
  return entry ? { ...entryOptions(entry) } : {}
}

/**
 * 在配置文件文本上应用 options 补丁，返回新文本。
 * 找不到本包 entry 时追加 { package, options }；plugins 字段非法或文档不是对象时抛错。
 */
export function patchPluginOptions(text: string, patch: Record<string, unknown>): string {
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('invalid config document')
  }
  const plugins = 'plugins' in config ? (config as Record<string, unknown>).plugins : undefined
  if (plugins !== undefined && !Array.isArray(plugins)) throw new Error('invalid plugins field')

  const list = (plugins ?? []) as readonly unknown[]
  const index = list.findIndex((entry) => isOwnSpec(entrySpec(entry)))

  let next: readonly unknown[]
  if (index < 0) {
    next = [...list, { package: PACKAGE_NAME, options: mergeOptions({}, patch) }]
  } else {
    next = list.map((entry, i) => {
      if (i !== index) return entry
      const options = mergeOptions(entryOptions(entry), patch)
      const spec = entrySpec(entry)
      if (typeof entry === 'string') return { package: spec, options }
      return { ...(entry as Record<string, unknown>), options }
    })
  }

  const updated = applyEdits(
    text,
    modify(text, ['plugins'], [...next], { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )
  return updated.endsWith('\n') ? updated : `${updated}\n`
}
