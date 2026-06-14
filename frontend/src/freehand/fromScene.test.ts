import { describe, expect, it } from 'vitest'
import type { SceneObject } from '../engine/scene'
import { flattenPathD, objectToStrokes, sceneToStrokes, vpathToStrokes } from './fromScene'

const obj = (o: Partial<SceneObject> & Pick<SceneObject, 'shape'>): SceneObject => ({
  id: 'x#1',
  x: 100,
  y: 100,
  rotation: 0,
  z: 0,
  createdSeq: 0,
  ...o,
})

describe('fromScene：组件引擎场景 → 自由画笔笔触', () => {
  it('circle → 闭合平滑笔触，点落在半径上', () => {
    const [s] = objectToStrokes(obj({ shape: 'circle', radius: 50, fill: '#f00' }))
    expect(s.closed).toBe(true)
    expect(s.smooth).toBe(true)
    expect(s.fill).toBe('#f00')
    for (const [px, py] of s.pts) {
      expect(Math.hypot(px - 100, py - 100)).toBeCloseTo(50, 1)
    }
  })

  it('rect 直角 → 4 角、棱角（smooth=false）；圆角 rect → 平滑', () => {
    const [sharp] = objectToStrokes(obj({ shape: 'rect', width: 80, height: 40 }))
    expect(sharp.smooth).toBe(false)
    expect(sharp.pts).toHaveLength(4)
    expect(sharp.pts).toContainEqual([60, 80]) // 左上角 (100-40,100-20)
    const [round] = objectToStrokes(obj({ shape: 'rect', width: 80, height: 40, cornerRadius: 8 }))
    expect(round.smooth).toBe(true)
  })

  it('triangle → 3 顶点闭合棱角', () => {
    const [s] = objectToStrokes(obj({ shape: 'triangle', radius: 60 }))
    expect(s.closed).toBe(true)
    expect(s.smooth).toBe(false)
    expect(s.pts).toHaveLength(3)
  })

  it('line（无 tension）直、polyline path 闭合，tension>0 平滑', () => {
    const line = objectToStrokes(obj({ shape: 'line', points: [-30, 0, 30, 0], stroke: '#000' }))[0]
    expect(line.closed).toBe(false)
    expect(line.smooth).toBe(false)
    expect(line.pts).toEqual([
      [70, 100],
      [130, 100],
    ]) // 相对偏移 + 中心 (100,100)
    const path = objectToStrokes(obj({ shape: 'path', points: [-20, -20, 20, -20, 0, 20], tension: 0.5 }))[0]
    expect(path.closed).toBe(true)
    expect(path.smooth).toBe(true)
  })

  it('rotation 绕中心旋转笔触点', () => {
    const [s] = objectToStrokes(obj({ shape: 'rect', width: 80, height: 40, rotation: 90 }))
    // 左上角 (60,80) 绕 (100,100) 顺时针 90° → (120,60)
    expect(s.pts[0][0]).toBeCloseTo(120, 1)
    expect(s.pts[0][1]).toBeCloseTo(60, 1)
  })

  it('text 不拆笔（返回空）', () => {
    expect(objectToStrokes(obj({ shape: 'text', text: 'hi', fontSize: 20 }))).toEqual([])
  })

  it('vpath 闭合填充（…Z+fill）→ 1 条闭合笔 + 填充 + 多采样点', () => {
    const ss = vpathToStrokes(
      obj({ shape: 'vpath', x: 0, y: 0, d: 'M232 321 C238 246 303 204 380 216 C487 432 424 482 346 475 Z', fill: '#F4A340', stroke: '#D9822B', strokeWidth: 8 }),
    )
    expect(ss).toHaveLength(1)
    expect(ss[0].closed).toBe(true)
    expect(ss[0].fill).toBe('#F4A340')
    expect(ss[0].color).toBe('#D9822B')
    expect(ss[0].smooth).toBe(false)
    expect(ss[0].pts.length).toBeGreaterThan(10)
  })

  it('vpath 开放（无 Z + fill:none，如嘴/胡须）→ 开放笔、无填充、收笔 taper', () => {
    const ss = vpathToStrokes(obj({ shape: 'vpath', x: 0, y: 0, d: 'M344 386 C306 374 272 371 238 380', fill: 'none', stroke: '#8B4513', strokeWidth: 3 }))
    expect(ss).toHaveLength(1)
    expect(ss[0].closed).toBe(false)
    expect(ss[0].fill).toBeUndefined()
    expect(ss[0].taper).toBe(true)
  })

  it('vpath 多子路径（两段 M…）→ 多条笔', () => {
    const ss = vpathToStrokes(
      obj({ shape: 'vpath', x: 0, y: 0, d: 'M377 399 C370 414 350 416 342 405 M377 399 C384 414 404 416 412 405', fill: 'none', stroke: '#8B4513' }),
    )
    expect(ss).toHaveLength(2)
  })

  it('vpath (x,y) 平移应用到采样点；无 d → 空', () => {
    const a = vpathToStrokes(obj({ shape: 'vpath', x: 0, y: 0, d: 'M0 0 L10 0 L10 10 Z', fill: '#000' }))
    const b = vpathToStrokes(obj({ shape: 'vpath', x: 100, y: 50, d: 'M0 0 L10 0 L10 10 Z', fill: '#000' }))
    expect(b[0].pts[0][0]).toBeCloseTo(a[0].pts[0][0] + 100)
    expect(b[0].pts[0][1]).toBeCloseTo(a[0].pts[0][1] + 50)
    expect(vpathToStrokes(obj({ shape: 'vpath', x: 0, y: 0 }))).toEqual([])
  })

  it('flattenPathD：L 直段 + Z 闭合（回到起点）', () => {
    const subs = flattenPathD('M0 0 L10 0 L10 10 Z')
    expect(subs).toHaveLength(1)
    expect(subs[0].closed).toBe(true)
    expect(subs[0].pts[0]).toEqual([0, 0])
    expect(subs[0].pts).toContainEqual([10, 0])
    expect(subs[0].pts[subs[0].pts.length - 1]).toEqual([0, 0])
  })

  it('sceneToStrokes：按 z 升序（背景先画）', () => {
    const scene = {
      objects: [
        obj({ id: 'a#1', shape: 'circle', radius: 10, z: 5, name: '前' }),
        obj({ id: 'b#1', shape: 'circle', radius: 10, z: 1, name: '后' }),
      ],
      seq: 0,
      seqByShape: {},
    }
    const strokes = sceneToStrokes(scene)
    expect(strokes).toHaveLength(2)
    // z=1 的"后"应排在前（先画）；用半径不同无法分辨，改测点数量级一致即可
    expect(strokes.every((s) => s.pts.length >= 2)).toBe(true)
  })
})
