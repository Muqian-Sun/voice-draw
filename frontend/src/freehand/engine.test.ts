import { describe, expect, it } from 'vitest'
import {
  cumulativeLengths,
  ribbonOutline,
  sampleCenterline,
  sliceUpTo,
  tipAt,
  widthProfile,
  type Pt,
} from './engine'

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

  it('widthProfile：taper 两端细中间粗；非 taper 恒定', () => {
    expect(widthProfile(10, 0, true)).toBeLessThan(widthProfile(10, 0.5, true))
    expect(widthProfile(10, 1, true)).toBeLessThan(widthProfile(10, 0.5, true))
    expect(widthProfile(10, 0.5, true)).toBeCloseTo(10) // 中点≈base
    expect(widthProfile(10, 0.2, false)).toBe(10)
  })

  it('ribbonOutline：左右各 n 点的闭合多边形（2n 点）', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ]
    const cum = cumulativeLengths(pts)
    const out = ribbonOutline(pts, cum, 20, 8, false)
    expect(out).toHaveLength(pts.length * 2)
    // 水平线、恒宽 8 → 上沿 y≈-4、下沿 y≈+4
    const ys = out.map((p) => p[1])
    expect(Math.min(...ys)).toBeCloseTo(-4)
    expect(Math.max(...ys)).toBeCloseTo(4)
  })
})
