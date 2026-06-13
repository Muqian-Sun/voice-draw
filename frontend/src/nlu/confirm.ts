/**
 * 破坏性操作确认窗口判定（协议 §4.3 / 规格 §2.6）。
 *
 * 用「包含」匹配而非整句精确相等——用户确认时常说「我确认 / 确认清空 / 好的，确认 / 确定吧 / 嗯可以」，
 * 旧逻辑 CONFIRM_YES_WORDS.includes(整句) 要求整句恰等于某个肯定词，带任何前后缀都会被误判为取消
 * （确认清空却没清、或反过来），对破坏性操作是数据/体验风险。
 *
 * 否定优先：句中含否定词（取消/不/别/算了/等等…）即取消，即使同时含肯定词（如「不用确认了」）；
 * 含肯定词且无否定词才确认；两者皆无 → 保守取消（§2.6）。
 */
import { CONFIRM_NO_WORDS, CONFIRM_YES_WORDS } from '../shared/lexicon'

export function isConfirmYes(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  if (CONFIRM_NO_WORDS.some((w) => t.includes(w))) return false
  return CONFIRM_YES_WORDS.some((w) => t.includes(w))
}
