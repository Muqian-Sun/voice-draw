import { describe, expect, it } from 'vitest'
import { isConfirmYes } from './confirm'

describe('isConfirmYes（确认窗口：包含匹配 + 否定优先，§2.6）', () => {
  it('裸肯定词与带前后缀的口语都判为确认', () => {
    for (const t of ['确认', '我确认', '确认清空', '好的，确认', '确定吧', '嗯可以', '清空吧', '对，删吧', '是的'])
      expect(isConfirmYes(t), t).toBe(true)
  })

  it('含否定词 → 取消（即使句中也含肯定词）', () => {
    for (const t of ['取消', '不要', '算了', '等等', '先别清空', '不用确认了', '不行'])
      expect(isConfirmYes(t), t).toBe(false)
  })

  it('无法匹配 / 空串 → 保守取消', () => {
    for (const t of ['', '   ', '画个圆', '随便'])
      expect(isConfirmYes(t), t).toBe(false)
  })
})
