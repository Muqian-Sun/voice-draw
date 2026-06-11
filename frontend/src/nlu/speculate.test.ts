/**
 * 投机解析单测（协议 §4.1）
 */
import { describe, expect, it } from 'vitest'
import { SpeculativeParser, normalizeUtterance } from './speculate'

describe('normalizeUtterance', () => {
  it('剔除标点与空白（final 含标点 / partial 通常没有）', () => {
    expect(normalizeUtterance('画一个红色的圆。')).toBe('画一个红色的圆')
    expect(normalizeUtterance('画一个 红色的圆，')).toBe('画一个红色的圆')
  })
})

describe('SpeculativeParser', () => {
  it('partial 预解析 + final 归一化命中 → 复用缓存（含纠错与规则结果）', () => {
    const sp = new SpeculativeParser()
    sp.onPartial('花一个红色的园', {})
    const r = sp.takeForFinal('花一个红色的园。')
    expect(r).not.toBeNull()
    expect(r!.corrected).toBe('画一个红色的圆')
    expect(r!.rule?.template).toBe('T1')
    expect(sp.stats).toEqual({ speculated: 1, hits: 1, misses: 0 })
  })

  it('final 与 partial 不一致 → miss，走正常解析', () => {
    const sp = new SpeculativeParser()
    sp.onPartial('画一个红色', {})
    expect(sp.takeForFinal('画一个红色的圆')).toBeNull()
    expect(sp.stats.misses).toBe(1)
  })

  it('同文本 partial 去重，不重复预解析', () => {
    const sp = new SpeculativeParser()
    sp.onPartial('画一个圆', {})
    sp.onPartial('画一个圆', {})
    expect(sp.stats.speculated).toBe(1)
  })

  it('缓存一次性：取走后再取为 null；无 partial 直接 final 不计 miss', () => {
    const sp = new SpeculativeParser()
    sp.onPartial('画一个圆', {})
    expect(sp.takeForFinal('画一个圆')).not.toBeNull()
    expect(sp.takeForFinal('画一个圆')).toBeNull()
    expect(sp.stats).toEqual({ speculated: 1, hits: 1, misses: 0 })
  })

  it('规则未命中的 partial 也缓存（corrected 复用，规则为 null 走 LLM）', () => {
    const sp = new SpeculativeParser()
    sp.onPartial('画一个雪人', {})
    const r = sp.takeForFinal('画一个雪人。')
    expect(r).not.toBeNull()
    expect(r!.rule).toBeNull()
  })
})
