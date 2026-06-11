import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { executeTransaction } from './interpreter'
import { createEmptyScene, getBBox, type SceneState } from './scene'

function run(ops: Op[], from?: SceneState) {
  const r = executeTransaction(from ?? createEmptyScene(), ops)
  expect(r.error, r.error?.message).toBeUndefined()
  return r.state
}

const bboxOfLast = (s: SceneState) => getBBox(s.objects[s.objects.length - 1])

/** 参照物：200×160 矩形居中 → bbox [412, 304, 200, 160] */
const HOUSE: Op = { op: 'create', shape: 'rect', name: '房子', width: 200, height: 160, at: { x: 512, y: 384 } }
const newRect = (at: Op extends { at?: infer P } ? P : never): Op =>
  ({ op: 'create', shape: 'rect', width: 60, height: 100, at }) as Op

describe('相对定位 ref=对象 外贴（规格 §5.3 公式逐 anchor 断言）', () => {
  const cases: Array<[string, unknown, [number, number, number, number]]> = [
    ['left（垂直居中，gap 20）', { ref: { byName: '房子' }, anchor: 'left' }, [332, 334, 60, 100]],
    ['right', { ref: { byName: '房子' }, anchor: 'right' }, [632, 334, 60, 100]],
    ['top（水平居中）', { ref: { byName: '房子' }, anchor: 'top' }, [482, 184, 60, 100]],
    ['bottom', { ref: { byName: '房子' }, anchor: 'bottom' }, [482, 484, 60, 100]],
    ['top-left（对角向外）', { ref: { byName: '房子' }, anchor: 'top-left' }, [332, 184, 60, 100]],
    ['bottom-right', { ref: { byName: '房子' }, anchor: 'bottom-right' }, [632, 484, 60, 100]],
    ['center（叠放）', { ref: { byName: '房子' }, anchor: 'center' }, [482, 334, 60, 100]],
    ['自定义 gap 60', { ref: { byName: '房子' }, anchor: 'left', gap: 60 }, [292, 334, 60, 100]],
    ['offset 叠加', { ref: { byName: '房子' }, anchor: 'left', offset: [10, -5] }, [342, 329, 60, 100]],
  ]
  it.each(cases)('%s', (_name, at, expected) => {
    const s = run([HOUSE, newRect(at as never)])
    expect(bboxOfLast(s)).toEqual(expected)
  })
})

describe('相对定位 ref=canvas 内贴（内边距 40）', () => {
  const cases: Array<[string, unknown, [number, number, number, number]]> = [
    ['bottom-right', { ref: 'canvas', anchor: 'bottom-right' }, [884, 668, 100, 60]],
    ['right（垂直居中）', { ref: 'canvas', anchor: 'right' }, [884, 354, 100, 60]],
    ['gap 覆盖内边距', { ref: 'canvas', anchor: 'top-left', gap: 10 }, [10, 10, 100, 60]],
  ]
  it.each(cases)('%s', (_name, at, expected) => {
    const s = run([{ op: 'create', shape: 'rect', width: 100, height: 60, at: at as never }])
    expect(bboxOfLast(s)).toEqual(expected)
  })
})

describe('相对尺寸（§2.4 维度规则）', () => {
  it('width/height 分别相对参照宽/高', () => {
    const s = run([
      HOUSE,
      {
        op: 'create',
        shape: 'rect',
        width: { relativeTo: { byName: '房子' }, factor: 0.5 },
        height: { relativeTo: { byName: '房子' }, factor: 0.25 },
        at: { x: 100, y: 100 },
      },
    ])
    const [, , w, h] = bboxOfLast(s)
    expect([w, h]).toEqual([100, 40])
  })

  it('size（特征尺寸）相对 max(参照宽,高)/2（"和房子差不多大的圆"）', () => {
    const s = run([HOUSE, { op: 'create', shape: 'circle', size: { relativeTo: { byName: '房子' }, factor: 0.5 }, at: { x: 200, y: 200 } }])
    expect(s.objects[1].radius).toBe(50) // max(200,160)/2 × 0.5
  })

  it('relativeTo 目标不存在 → TARGET_NOT_FOUND', () => {
    const r = executeTransaction(createEmptyScene(), [
      { op: 'create', shape: 'circle', size: { relativeTo: { byName: '幽灵' }, factor: 1 } },
    ])
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
  })

  it('System Prompt 例2 全链路："在房子左边画一棵比它矮的树"', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '房子', size: 'large', at: { x: 600, y: 450 }, fill: '#8B4513' },
      {
        op: 'create',
        shape: 'rect',
        name: '树干',
        width: 24,
        height: { relativeTo: { byName: '房子' }, factor: 0.4 },
        at: { ref: { byName: '房子' }, anchor: 'left', gap: 60 },
        fill: '#8B4513',
      },
      {
        op: 'create',
        shape: 'triangle',
        name: '树冠',
        size: { relativeTo: { byName: '房子' }, factor: 0.3 },
        at: { ref: { byName: '树干' }, anchor: 'top', gap: 0 },
        fill: '#2ECC40',
      },
    ])
    const [hx] = getBBox(s.objects[0]) // 房子 bbox [440,330,320,240]
    const [tx, ty, tw, th] = getBBox(s.objects[1]) // 树干
    const [, cy2, , ch] = getBBox(s.objects[2]) // 树冠
    expect(tx + tw).toBe(hx - 60) // 树干右缘贴房子左缘 - gap
    expect(th).toBe(96) // 0.4 × 240，比房子矮
    expect(cy2 + ch).toBeCloseTo(ty, 6) // 树冠底贴树干顶
    expect(ty + th).toBeLessThan(330 + 240) // 树整体不高于房子底
  })
})

describe('自动布局（§5.2 确定性算法）', () => {
  it('有焦点：优先放右侧（gap 40，垂直居中）', () => {
    const s = run([{ op: 'create', shape: 'circle' }, { op: 'create', shape: 'rect' }])
    // circle#1 bbox [432,304,160,160]；rect 160×120 → 右侧 center (712, 384)
    expect(bboxOfLast(s)).toEqual([632, 324, 160, 120])
  })

  it('焦点四侧都不可用：回退九宫格首个可用锚点', () => {
    const s = run([
      { op: 'create', shape: 'circle' }, // 居中 r80
      { op: 'create', shape: 'rect', name: '墙', width: 300, height: 700, at: { x: 790, y: 384 } }, // 焦点，右/下/上越界，左与圆重叠
      { op: 'create', shape: 'circle', size: 40 },
    ])
    expect(bboxOfLast(s)).toEqual([40, 40, 80, 80]) // 九宫格 center 与圆重叠 → top-left
  })

  it('画布很满：center 叠放不报错', () => {
    const s = run([
      { op: 'create', shape: 'rect', width: 900, height: 700, at: { x: 512, y: 384 } },
      { op: 'create', shape: 'circle' },
    ])
    const o = s.objects[1]
    expect([o.x, o.y]).toEqual([512, 384])
  })
})

describe('越界 clamp（§5.5）', () => {
  it('create 越界：平移最小距离入界并产生 notice', () => {
    const r = executeTransaction(createEmptyScene(), [
      { op: 'create', shape: 'circle', size: 80, at: { x: 1100, y: 384 } },
    ])
    expect(r.error).toBeUndefined()
    const [bx, , bw] = getBBox(r.state.objects[0])
    expect(bx + bw).toBe(1024)
    expect(r.notices).toHaveLength(1)
  })

  it('move delta 越界：拉回画布内', () => {
    const s = run([{ op: 'create', shape: 'circle', size: 80, at: { x: 512, y: 384 } }])
    const r = executeTransaction(s, [{ op: 'move', target: { byFocus: true }, delta: [2000, 0] }])
    expect(r.error).toBeUndefined()
    expect(r.state.objects[0].x).toBe(944) // 1024 - 80
    expect(r.notices).toHaveLength(1)
  })

  it('对象大于画布：等比缩小至 90% 后居中', () => {
    const r = executeTransaction(createEmptyScene(), [{ op: 'create', shape: 'circle', size: 2000 }])
    expect(r.error).toBeUndefined()
    const o = r.state.objects[0]
    expect(o.radius).toBeCloseTo(345.6, 4) // 2000 × 0.9 × min(1024,768)/4000
    expect([o.x, o.y]).toEqual([512, 384])
    expect(r.notices).toHaveLength(1)
  })
})

describe('move.to 相对定位（与 create.at 同语义）', () => {
  it('把圆移到房子上方', () => {
    const s = run([HOUSE, { op: 'create', shape: 'circle', size: 30, at: { x: 100, y: 100 } }])
    const r = executeTransaction(s, [
      { op: 'move', target: { byFocus: true }, to: { ref: { byName: '房子' }, anchor: 'top' } },
    ])
    expect(r.error).toBeUndefined()
    const [, by, , bh] = getBBox(r.state.objects[1])
    expect(by + bh).toBe(304 - 20) // 圆底 = 房子顶 - gap 20
    expect(r.state.objects[1].x).toBe(512) // 水平居中对齐
  })
})
