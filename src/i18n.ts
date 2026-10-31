export type Lang = 'zh' | 'en'

export interface Strings {
  /** 注入 system 的防复读 + 语言约束 */
  guardHint: string
  /** 续跑 prompt */
  resumePrompt: string
  /** 连救超限后注入的提示 */
  giveUpHint: string
  /** 中毒文本被截断后的占位标记 */
  prunedMarker: string
  /** 意图循环时的转向提示 */
  steerHint: string
}

const ZH: Strings = {
  guardHint:
    '[loop-recover] 上一次输出进入了重复循环。继续完成任务，但不要重复之前已经生成过的内容；' +
    '如果卡住，换一种思路或直接给出当前最优结果。请使用中文回复。',
  resumePrompt:
    '刚才的输出检测到重复循环，已被中断并清理。请换一种思路继续完成原任务，' +
    '不要重复之前已经生成过的内容。',
  giveUpHint:
    '[loop-recover] 连续多次检测到循环且救援未能收敛，已停止自动干预。请人工检查任务或更换模型。',
  prunedMarker: '…[loop-recover: 已截断重复内容]…',
  steerHint: '[loop-recover] 你正在用不同措辞重复同一个查询。请停止重试，改用已有信息作答或换一种完全不同的方法。',
}

const EN: Strings = {
  guardHint:
    '[loop-recover] Your previous output entered a repetition loop. Continue the task without ' +
    'repeating what was already generated; if stuck, change approach or give the best current answer. ' +
    'Reply in English.',
  resumePrompt:
    'The previous output was detected as a repetition loop and has been interrupted and pruned. ' +
    'Continue the original task with a different approach; do not repeat what was already generated.',
  giveUpHint:
    '[loop-recover] Repeated loops detected and rescues did not converge; automatic intervention is ' +
    'now disabled for this session. Please review the task or switch model.',
  prunedMarker: '…[loop-recover: repeated content truncated]…',
  steerHint:
    '[loop-recover] You are repeating the same query with different wording. Stop retrying; ' +
    'answer with the information you already have or use a completely different method.',
}

export function strings(lang: Lang): Strings {
  return lang === 'zh' ? ZH : EN
}

/**
 * 解析语言偏好：显式 zh/en 优先；auto 时看宿主 locale（含 'zh' 即中文），兜底 en。
 */
export function resolveLanguage(pref: Config['language'] | string, appLocale?: string): Lang {
  if (pref === 'zh' || pref === 'en') return pref
  if (appLocale && appLocale.toLowerCase().includes('zh')) return 'zh'
  return 'en'
}

// 仅供类型引用，避免循环依赖
interface Config {
  language: 'auto' | 'zh' | 'en'
}
