import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Logger = (msg: string) => void

export const noopLog: Logger = () => {}

/** 文件日志：每条一行 `<ISO> <msg>`；路径为 false/空时静默。 */
export function createLogger(target: string | false | undefined): Logger {
  if (!target) return noopLog
  const dir = dirname(target)
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
  return (msg) => {
    try {
      appendFileSync(target, `${new Date().toISOString()} ${msg}\n`)
    } catch {
      // 日志失败绝不能影响主流程
    }
  }
}
