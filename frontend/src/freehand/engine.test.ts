import { describe, expect, it } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { cumulativeLengths, densifyLinear, sampleCenterline, sliceUpTo, tipAt, type Pt } from './engine'

describe('自由画笔引擎', () => {
  it('sampleCenterline：稠密化且过首尾锚点；<2 点原样', () => {
    expect(sampleCenterline([[0, 0]], false)).toEqual([[0, 0]])
    const pts: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 100],
    ]
    const dense = sampleCenterline(pts, false, 10)
    expect(dense.length).toBeGreaterThan(pts.length)
    expect(dense[0]).toEqual([0, 0]) // 过首锚点
    expect(dense[dense.length - 1]).toEqual([100, 100]) // 过末锚点
  })

  it('cumulativeLengths：单调不减、首 0、直线段=欧氏距离', () => {
    const cum = cumulativeLengths([
      [0, 0],
      [3, 4],
      [3, 4],
      [6, 8],
    ])
    expect(cum[0]).toBe(0)
    expect(cum[1]).toBeCloseTo(5)
    expect(cum[2]).toBeCloseTo(5) // 重合点不增长
    expect(cum[3]).toBeCloseTo(10)
  })

  it('sliceUpTo：按弧长截前缀，末端段内插值', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ]
    const cum = cumulativeLengths(pts)
    expect(sliceUpTo(pts, cum, 0)).toEqual([[0, 0]])
    expect(sliceUpTo(pts, cum, 5)).toEqual([
      [0, 0],
      [5, 0],
    ]) // 段内插到 x=5
    expect(sliceUpTo(pts, cum, 100)).toEqual(pts) // 超长返回全段
  })

  it('tipAt：笔尖在已绘末端，切向角沿运笔方向', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
    ]
    const cum = cumulativeLengths(pts)
    const { pt, angle } = tipAt(pts, cum, 5)
    expect(pt[0]).toBeCloseTo(5)
    expect(angle).toBeCloseTo(0) // 向 +x
  })

  it('densifyLinear：直线段线性稠密化保棱角（闭合回首点）', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ]
    const dense = densifyLinear(pts, true, 4)
    expect(dense.length).toBeGreaterThan(pts.length)
    expect(dense[0]).toEqual([0, 0])
    expect(dense[dense.length - 1]).toEqual([0, 0]) // 闭合回首点
  })

  it('perfect-freehand getStroke：输入点 → 非空轮廓多边形（依赖接入冒烟）', () => {
    const outline = getStroke(
      [
        [0, 0],
        [10, 5],
        [20, 12],
        [35, 18],
      ],
      { size: 16, thinning: 0.5, simulatePressure: true },
    )
    expect(Array.isArray(outline)).toBe(true)
    expect(outline.length).toBeGreaterThan(3)
    expect(outline.every((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
  })
})
