import { resolveDetectorOptions, type DetectorOptions } from './detect/detector.ts'
import { resolveIntentOptions, type IntentOptions } from './detect/intent.ts'

export type Mode = 'rescue' | 'cut' | 'observe'

export interface Config {
  mode: Mode
  /** 各检测器开关 */
  detectors: {
    periodic: boolean
    ngram: boolean
    anchor: boolean
    charrun: boolean
    pool: boolean
    intent: boolean
  }
  detector: DetectorOptions
  intent: IntentOptions
  /** 同一 session 连续救援上限，超过后转 observe。默认 3 */
  maxRescues: number
  /** 滚动缓冲尾部窗口（字符）。默认 8192 */
  bufferChars: number
  /** 续跑指令模板；支持 {lang} 占位。默认见 i18n */
  rescuePrompt?: string
  /** 注入防复读+语言约束到 system。默认 true */
  keepLanguage: boolean
  /** 语言偏好：'auto' | 'zh' | 'en'。默认 auto（按 app.locale） */
  language: 'auto' | 'zh' | 'en'
  /** 命中后下次请求的温度/topP 扰动上限。默认 0.3；0 关闭 */
  temperatureBump: number
  /** debug 日志路径；false 关闭。默认 false */
  debugLog: string | false
}

export const DEFAULT_CONFIG: Config = {
  mode: 'rescue',
  detectors: { periodic: true, ngram: true, anchor: true, charrun: true, pool: true, intent: true },
  detector: resolveDetectorOptions(),
  intent: resolveIntentOptions(),
  maxRescues: 3,
  bufferChars: 8192,
  keepLanguage: true,
  language: 'auto',
  temperatureBump: 0.3,
  debugLog: false,
}

const MODES: readonly Mode[] = ['rescue', 'cut', 'observe']

/** ctx.options → Config：unknown 值逐项校验，非法项回落默认。 */
export function resolveConfig(raw: unknown): Config {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cfg = structuredClone(DEFAULT_CONFIG)

  const mode = input.mode
  if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) cfg.mode = mode as Mode

  const detectors = input.detectors
  if (detectors && typeof detectors === 'object') {
    for (const key of Object.keys(cfg.detectors) as (keyof Config['detectors'])[]) {
      const value = (detectors as Record<string, unknown>)[key]
      if (typeof value === 'boolean') cfg.detectors[key] = value
    }
  }

  cfg.detector = resolveDetectorOptions(
    (input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : {}) as Partial<DetectorOptions>,
  )
  cfg.intent = resolveIntentOptions(
    (input.intent && typeof input.intent === 'object' ? input.intent : {}) as Partial<IntentOptions>,
  )

  if (typeof input.maxRescues === 'number' && input.maxRescues >= 1) cfg.maxRescues = input.maxRescues
  if (typeof input.bufferChars === 'number' && input.bufferChars >= 256) cfg.bufferChars = input.bufferChars
  if (typeof input.rescuePrompt === 'string' && input.rescuePrompt.trim()) cfg.rescuePrompt = input.rescuePrompt
  if (typeof input.keepLanguage === 'boolean') cfg.keepLanguage = input.keepLanguage
  if (input.language === 'zh' || input.language === 'en' || input.language === 'auto') cfg.language = input.language
  if (typeof input.temperatureBump === 'number' && input.temperatureBump >= 0) cfg.temperatureBump = input.temperatureBump
  if (input.debugLog === false) cfg.debugLog = false
  else if (typeof input.debugLog === 'string' && input.debugLog.trim()) cfg.debugLog = input.debugLog

  return cfg
}
