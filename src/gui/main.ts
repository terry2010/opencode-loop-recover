/**
 * opencode-loop-recover — GUI 插件的 main 进程入口。
 *
 * 桌面 main 进程持有 Node fs 权限；这里负责把设置页的 options 补丁写回全局
 * opencode.json(c)（与 `opencode plugin add` 相同的 jsonc 保注释编辑 + tmp/rename 原子写）。
 * opencode 的 config watcher 看到文件变化后自动重载 server 与 GUI 插件，新 options 生效。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/gui'
import { ConfigIpc } from './contract.ts'
import { patchPluginOptions, readPluginOptions } from './config-patch.ts'

/** 全局配置目录：与 @opencode/util/global 相同规则。 */
function configDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
  return path.join(xdg, 'opencode')
}

/** 与 CLI resolveConfigPath 相同的候选顺序；都不存在时返回第一个。 */
async function resolveConfigPath(): Promise<string> {
  const directory = configDirectory()
  const candidates = [
    path.join(directory, 'opencode.json'),
    path.join(directory, 'opencode.jsonc'),
    path.join(directory, '.opencode', 'opencode.json'),
    path.join(directory, '.opencode', 'opencode.jsonc'),
  ]
  for (const candidate of candidates) {
    const exists = await stat(candidate).then(
      (info) => info.isFile(),
      () => false,
    )
    if (exists) return candidate
  }
  return candidates[0]
}

const readConfigText = async (file: string): Promise<string> =>
  readFile(file, 'utf8').catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return '{}'
    throw error
  })

const main: Plugin.MainSetup = (ctx) => {
  ctx.provide(ConfigIpc, {
    configPath: () => resolveConfigPath(),
    getOptions: async () => readPluginOptions(await readConfigText(await resolveConfigPath())),
    setOptions: async (patch) => {
      const file = await resolveConfigPath()
      const updated = patchPluginOptions(await readConfigText(file), patch)
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      await writeFile(temporary, updated, { mode: 0o600 })
      await rename(temporary, file)
      ctx.log.write('info', 'loop-recover options updated', { file })
    },
  })
}

export default main
