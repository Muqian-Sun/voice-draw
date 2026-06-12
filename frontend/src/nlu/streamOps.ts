/**
 * 流式 Op 提取（协议 §2 v1.4 渐进绘制）
 *
 * LLM 输出的 JSON 是逐 token 到达的；本模块在不完整文本上增量识别
 * `"ops": [ {...}, {...} ]` 数组里**每个完整的 Op 对象**，写完一个交付一个。
 * 字符级状态机：跟踪字符串/转义/括号深度，避免把字符串里的 {} 当结构。
 * 同时捕获 ops 之前出现的 intent/confidence（字段顺序由 System Prompt 约定），
 * 供调用方在执行前判断是否该渐进绘制（clarify/低置信不画）。
 */

export interface StreamedHead {
  intent?: string
  confidence?: number
}

export class OpStreamExtractor {
  private buf = ''
  private i = 0 // 扫描指针（只前进）
  private inString = false
  private escape = false
  private depth = 0
  /** ops 数组所在深度（进入后 = 数组内对象起始深度-1）；-1 = 尚未进入 */
  private opsArrayDepth = -1
  private opStart = -1

  readonly head: StreamedHead = {}

  /** 喂一段增量文本，返回本次新完成的 Op（原始对象，未过 zod） */
  feed(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    while (this.i < this.buf.length) {
      const ch = this.buf[this.i]
      if (this.inString) {
        if (this.escape) this.escape = false
        else if (ch === '\\') this.escape = true
        else if (ch === '"') this.inString = false
        this.i++
        continue
      }
      if (ch === '"') {
        this.inString = true
        this.i++
        continue
      }
      if (ch === '{' || ch === '[') {
        // 顶层对象内、尚未进入 ops 时，检测 `"ops"` 键后的 `[`
        if (ch === '[' && this.opsArrayDepth === -1 && /"ops"\s*:\s*$/.test(this.buf.slice(0, this.i))) {
          this.opsArrayDepth = this.depth
          this.captureHead()
        } else if (this.opsArrayDepth !== -1 && this.depth === this.opsArrayDepth + 1 && ch === '{' && this.opStart === -1) {
          this.opStart = this.i
        }
        this.depth++
        this.i++
        continue
      }
      if (ch === '}' || ch === ']') {
        this.depth--
        if (this.opStart !== -1 && ch === '}' && this.depth === this.opsArrayDepth + 1) {
          const raw = this.buf.slice(this.opStart, this.i + 1)
          this.opStart = -1
          try {
            out.push(JSON.parse(raw))
          } catch {
            /* 不完整或非法的对象忽略，整体校验在流结束后兜底 */
          }
        }
        if (this.opsArrayDepth !== -1 && ch === ']' && this.depth === this.opsArrayDepth) {
          this.opsArrayDepth = -2 // ops 数组闭合，后续不再产出
        }
        this.i++
        continue
      }
      this.i++
    }
    return out
  }

  /** ops 数组之前的 intent / confidence（执行前路由判断用） */
  private captureHead(): void {
    const headText = this.buf.slice(0, this.i)
    const intent = headText.match(/"intent"\s*:\s*"(\w+)"/)
    if (intent) this.head.intent = intent[1]
    const conf = headText.match(/"confidence"\s*:\s*([0-9.]+)/)
    if (conf) this.head.confidence = Number(conf[1])
  }

  /** 完整原始文本（流结束后做权威校验用） */
  fullText(): string {
    return this.buf
  }
}
