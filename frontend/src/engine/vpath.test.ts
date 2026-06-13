/**
 * v2.0 贝塞尔矢量路径（vpath）引擎链路：schema 校验 → 解释器建对象 → getBBox。
 * 渲染（Path2D 清晰填充+描边）由 FreehandSceneStage.drawVPath 负责，与 SVG <path d> 等价。
 */
import { describe, expect, it } from 'vitest'
import { parseOps } from '../dsl'
import { executeTransaction } from './interpreter'
import { createEmptyScene, getBBox } from './scene'

const D = 'M100 100 C150 60 250 60 300 100 C340 140 340 220 300 260 C250 300 150 300 100 260 C60 220 60 140 100 100 Z'

describe('vpath：贝塞尔矢量路径', () => {
  it('schema：vpath 需 d；缺 d 被拒', () => {
    expect(parseOps([{ op: 'create', shape: 'vpath', name: '身体', d: D, fill: '#FFF' }]).ok).toBe(true)
    expect(parseOps([{ op: 'create', shape: 'vpath', name: '身体', fill: '#FFF' }]).ok).toBe(false)
  })

  it('解释器：create vpath → 命名场景对象带 d，焦点=该对象', () => {
    const parsed = parseOps([
      { op: 'create', shape: 'vpath', name: '羊身体', d: D, fill: '#F4F1E8', stroke: '#6B5D50', strokeWidth: 8 },
    ])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    expect(state.objects).toHaveLength(1)
    const o = state.objects[0]
    expect(o.shape).toBe('vpath')
    expect(o.name).toBe('羊身体')
    expect(o.d).toBe(D)
    expect(o.fill).toBe('#F4F1E8')
    expect(o.stroke).toBe('#6B5D50')
    expect(o.strokeWidth).toBe(8)
    expect(state.focusId).toBe(o.id)
  })

  it('getBBox：从 d 的坐标算包围盒（含 x,y 平移偏移）', () => {
    const parsed = parseOps([{ op: 'create', shape: 'vpath', name: 'p', d: D, fill: '#FFF' }])
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    const [bx, by, bw, bh] = getBBox(state.objects[0])
    // d 的坐标 x∈[60,340] y∈[60,300]
    expect(bx).toBe(60)
    expect(by).toBe(60)
    expect(bw).toBe(280)
    expect(bh).toBe(240)
  })

  it('mirror：vpath 逐点反射 d 坐标（不再整条平移错位）', () => {
    const parsed = parseOps([
      { op: 'create', shape: 'circle', name: '躯干', at: { x: 50, y: 0 }, size: 10 },
      { op: 'create', shape: 'vpath', name: '左', d: 'M0 0 L100 0 L100 40 Z' },
      { op: 'mirror', target: { byName: '左' }, about: { byName: '躯干' }, name: '右' },
    ])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    const right = state.objects.find((o) => o.name === '右')
    expect(right?.shape).toBe('vpath')
    expect(right?.x).toBe(0) // 0 偏移（不再是 2*cx 的平移错位）
    expect(right?.y).toBe(0)
    // 关于 cx=50 竖直反射：x'=100-x；y 不变 → 'M100 0 L0 0 L0 40 Z'
    expect(right?.d).toBe('M100 0 L0 0 L0 40 Z')
  })

  it('P2 编辑：resize 缩放 d（绕中心）→ 尺寸变、中心不动；move 平移；style 改色', () => {
    const parsed = parseOps([
      { op: 'create', shape: 'vpath', name: '眼', d: D, fill: '#000' }, // D 的 bbox=[60,60,280,240]，中心(200,180)
      { op: 'resize', target: { byName: '眼' }, scale: 1.2 }, // 1.2× 不出界（避免 §5.5 clamp 干扰中心断言）
      { op: 'style', target: { byName: '眼' }, fill: '#0074D9' },
    ])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    const o = state.objects[0]
    const [bx, by, bw, bh] = getBBox(o)
    expect(bw).toBeCloseTo(336, 0) // 280×1.2（resize 缩放 d 生效）
    expect(bh).toBeCloseTo(288, 0) // 240×1.2
    expect(bx + bw / 2).toBeCloseTo(200, 0) // 中心 x 不动（绕中心缩放）
    expect(by + bh / 2).toBeCloseTo(180, 0) // 中心 y 不动
    expect(o.fill).toBe('#0074D9') // style 改色生效
  })

  it('P2 编辑：move delta 平移 vpath（x 偏移，getBBox 整体右移）', () => {
    const parsed = parseOps([
      { op: 'create', shape: 'vpath', name: '球', d: D, fill: '#000' },
      { op: 'move', target: { byName: '球' }, delta: [100, 0] },
    ])
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    const [bx] = getBBox(state.objects[0])
    expect(bx).toBeCloseTo(160, 0) // 原 bx=60 + 平移 100
  })

  it('多条命名 vpath：各自独立、按创建顺序 z 递增（插画=多命名 path）', () => {
    const parsed = parseOps([
      { op: 'create', shape: 'vpath', name: '身体', d: D },
      { op: 'create', shape: 'vpath', name: '头', d: D },
      { op: 'create', shape: 'vpath', name: '眼', d: D },
    ])
    if (!parsed.ok) return
    const { state } = executeTransaction(createEmptyScene(), parsed.ops)
    expect(state.objects.map((o) => o.name)).toEqual(['身体', '头', '眼'])
    expect(state.objects[0].z).toBeLessThan(state.objects[2].z)
  })
})
