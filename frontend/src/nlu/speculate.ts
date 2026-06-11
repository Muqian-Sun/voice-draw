/**
 * partial 投机解析（协议 §4.1 / 架构文档"延迟"应对）
 *
 * ASR partial 到达即做 纠错 + 规则层预解析并缓存；final 到达时与最后一次
 * partial 归一化比对（火山 final 含标点/ITN，partial 通常没有——只比内容字符），
 * 一致则直接复用缓存结果，省去 final 路径的纠错与模板匹配。
 * 只投机规则层：LLM 投机会对每个 partial 产生计费调用，成本收益不成立。
 */
import { correctTranscript } from './correction'
import { parseRule, type RuleContext, type RuleParseResult } from './rules'

export interface SpeculationResult {
  corrected: string
  original: string
  rule: RuleParseResult | null
}

export interface SpeculationStats {
  /** 投机执行的预解析次数（去重后） */
  speculated: number
  /** final 命中缓存次数 */
  hits: number
  /** 有缓存但 final 不一致 */
  misses: number
}

/** 归一化：剔除标点与空白，只留内容字符（partial/final 的典型差异） */
export function normalizeUtterance(text: string): string {
  return text.replace(/[\s，。、,.!?！？;；:：…~～]/g, '')
}

export class SpeculativeParser {
  private last: { raw: string; result: SpeculationResult } | null = null
  readonly stats: SpeculationStats = { speculated: 0, hits: 0, misses: 0 }

  /** partial 到达：预解析并缓存（同文本去重） */
  onPartial(text: string, ctx: RuleContext): void {
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed === this.last?.raw) return
    this.stats.speculated += 1
    const corr = correctTranscript(trimmed)
    this.last = {
      raw: trimmed,
      result: { corrected: corr.corrected, original: corr.original, rule: parseRule(corr.corrected, ctx) },
    }
  }

  /** final 到达：归一化一致则取走缓存（一次性），否则返回 null 走正常解析 */
  takeForFinal(finalText: string): SpeculationResult | null {
    const cached = this.last
    this.last = null
    if (cached === null) return null
    if (normalizeUtterance(cached.raw) === normalizeUtterance(finalText)) {
      this.stats.hits += 1
      return cached.result
    }
    this.stats.misses += 1
    return null
  }
}
