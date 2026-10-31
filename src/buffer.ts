/**
 * 滚动文本缓冲：只保留尾部 window 个字符，供检测器增量扫描。
 * 检测器自身只看尾部窗口，因此缓冲被截断不会漏检。
 */
export class RollingBuffer {
  private buf = ''
  private nextCheck: number
  private readonly window: number
  private readonly checkEvery: number
  private readonly minLen: number

  constructor(window: number, checkEvery = 32, minLen = 256) {
    this.window = window
    this.checkEvery = checkEvery
    this.minLen = minLen
    this.nextCheck = this.minLen
  }

  append(delta: string): void {
    this.buf += delta
    if (this.buf.length > this.window) this.buf = this.buf.slice(this.buf.length - this.window)
  }

  /** 摊销：文本达到阈值且又累计了 checkEvery 字符才返回 true（与 StreamLoopDetector 同策略）。 */
  needsCheck(): boolean {
    if (this.buf.length < this.nextCheck) return false
    this.nextCheck = this.buf.length - (this.buf.length % this.checkEvery) + this.checkEvery
    return true
  }

  text(): string {
    return this.buf
  }

  get length(): number {
    return this.buf.length
  }
}

/** 每个 (sessionID, messageID, ordinal) 一份缓冲；part 结束即释放。 */
export class BufferPool {
  private buffers = new Map<string, RollingBuffer>()
  private readonly window: number

  constructor(window: number) {
    this.window = window
  }

  static key(sessionID: string, messageID: string, ordinal: number): string {
    return `${sessionID}:${messageID}:${ordinal}`
  }

  get(sessionID: string, messageID: string, ordinal: number): RollingBuffer {
    const key = BufferPool.key(sessionID, messageID, ordinal)
    let buf = this.buffers.get(key)
    if (!buf) {
      buf = new RollingBuffer(this.window)
      this.buffers.set(key, buf)
    }
    return buf
  }

  drop(sessionID: string, messageID: string, ordinal: number): void {
    this.buffers.delete(BufferPool.key(sessionID, messageID, ordinal))
  }

  dropSession(sessionID: string): void {
    const prefix = `${sessionID}:`
    for (const key of this.buffers.keys()) {
      if (key.startsWith(prefix)) this.buffers.delete(key)
    }
  }
}
