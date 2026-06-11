import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { executeTransaction } from './interpreter'
import { createEmptyScene, getBBox, type SceneState } from './scene'

/** 测试辅助：从空场景执行事务，断言无错误 */
function run(ops: Op[], from?: SceneState) {
  const r = executeTransaction(from ?? createEmptyScene(), ops)
  expect(r.error, r.error?.message).toBeUndefined()
  return r.state
}

describe('create（规格 §2.4 几何换算 / §5.1 焦点）', () => {
  it('最简圆形：缺省 medium（半径 80）、画布中心、缺省填充、id=circle#1、获得焦点', () => {
    const s = run([{ op: 'create', shape: 'circle' }])
    expect(s.objects).toHaveLength(1)
    const o = s.objects[0]
    expect(o.id).toBe('circle#1')
    expect(o.radius).toBe(80)
    expect([o.x, o.y]).toEqual([512, 384])
    expect(o.fill).toBe('#4B5563')
    expect(s.focusId).toBe('circle#1')
  })

  it('语义尺寸 large 矩形：宽 320 高 240（2v × 1.5v），(x,y) 为中心', () => {
    const s = run([{ op: 'create', shape: 'rect', size: 'large', at: { x: 200, y: 150 } }])
    const o = s.objects[0]
    expect([o.width, o.height]).toEqual([320, 240])
    expect(getBBox(o)).toEqual([40, 30, 320, 240])
  })

  it('显式 width/height 优先于 size', () => {
    const s = run([{ op: 'create', shape: 'rect', size: 'large', width: 100, height: 50 }])
    expect([s.objects[0].width, s.objects[0].height]).toEqual([100, 50])
  })

  it('line 无 points 时生成水平线（长 3v）且缺省描边', () => {
    const s = run([{ op: 'create', shape: 'line', size: 40, at: { x: 500, y: 300 } }])
    const o = s.objects[0]
    expect(o.points).toEqual([-60, 0, 60, 0])
    expect(o.stroke).toBe('#111827')
    const [bx, by, bw, bh] = getBBox(o)
    expect([bx, by, bw, bh]).toEqual([440, 300, 120, 0])
  })

  it('text 缺省 fontSize = max(16, 0.5v)', () => {
    const s = run([{ op: 'create', shape: 'text', text: '你好' }])
    expect(s.objects[0].fontSize).toBe(40) // v=medium=80
  })

  it('id 按形状独立递增，z 单调递增', () => {
    const s = run([
      { op: 'create', shape: 'circle' },
      { op: 'create', shape: 'rect' },
      { op: 'create', shape: 'circle' },
    ])
    expect(s.objects.map((o) => o.id)).toEqual(['circle#1', 'rect#1', 'circle#2'])
    expect(s.objects.map((o) => o.z)).toEqual([1, 2, 3])
    expect(s.focusId).toBe('circle#2')
  })

  it('相对定位 ref=canvas 内贴（左上角，内边距 40）', () => {
    const s = run([{ op: 'create', shape: 'rect', width: 100, height: 60, at: { ref: 'canvas', anchor: 'top-left' } }])
    expect(getBBox(s.objects[0])).toEqual([40, 40, 100, 60])
  })
})

describe('目标解析（协议 §1.3）', () => {
  const base = run([
    { op: 'create', shape: 'circle', name: '太阳', fill: '#FFD700', at: { x: 100, y: 100 } },
    { op: 'create', shape: 'circle', fill: '#FF4136', at: { x: 300, y: 100 } },
    { op: 'create', shape: 'rect', name: '房子', at: { x: 500, y: 400 } },
  ])

  it('byName 命中', () => {
    const s = run([{ op: 'style', target: { byName: '房子' }, fill: '#8B4513' }], base)
    expect(s.objects.find((o) => o.name === '房子')!.fill).toBe('#8B4513')
  })

  it('byId 不存在 → TARGET_NOT_FOUND', () => {
    const r = executeTransaction(base, [{ op: 'delete', target: { byId: 'star#9' } }])
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
  })

  it('byQuery shape+fill 精确消歧（大小写不敏感）', () => {
    const s = run([{ op: 'move', target: { byQuery: { shape: 'circle', fill: '#ffd700' } }, delta: [0, 50] }], base)
    expect(s.objects.find((o) => o.name === '太阳')!.y).toBe(150)
  })

  it('byQuery 多命中且无 ordinal → AMBIGUOUS_TARGET 携带候选', () => {
    const r = executeTransaction(base, [{ op: 'delete', target: { byQuery: { shape: 'circle' } } }])
    expect(r.error?.code).toBe('AMBIGUOUS_TARGET')
    expect(r.error?.candidateIds).toEqual(['circle#1', 'circle#2'])
  })

  it('byQuery ordinal 按创建顺序（"第二个圆"）', () => {
    const s = run([{ op: 'style', target: { byQuery: { shape: 'circle', ordinal: 2 } }, fill: '#0074D9' }], base)
    expect(s.objects[1].fill).toBe('#0074D9')
  })

  it('byQuery ordinal last', () => {
    const s = run([{ op: 'style', target: { byQuery: { shape: 'circle', ordinal: 'last' } }, opacity: 0.5 }], base)
    expect(s.objects[1].opacity).toBe(0.5)
  })

  it('byQuery ordinal 越界 → TARGET_NOT_FOUND', () => {
    const r = executeTransaction(base, [{ op: 'delete', target: { byQuery: { shape: 'circle', ordinal: 5 } } }])
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
  })

  it('byFocus 无焦点 → TARGET_NOT_FOUND', () => {
    const noFocus: SceneState = { ...base, focusId: undefined }
    const r = executeTransaction(noFocus, [{ op: 'style', target: { byFocus: true }, fill: '#111111' }])
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
  })
})

describe('move / style / delete 与焦点规则（规格 §5.1）', () => {
  it('move delta 平移并设焦点（"把它往右移一点"链路）', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', size: 40, at: { x: 100, y: 100 } },
      { op: 'create', shape: 'rect', at: { x: 600, y: 400 } },
    ])
    const s = run([{ op: 'move', target: { byQuery: { shape: 'circle' } }, delta: [60, 0] }], s0)
    expect(s.objects[0].x).toBe(160)
    expect(s.focusId).toBe('circle#1')
    // 焦点已切到圆 → byFocus 继续操作圆
    const s2 = run([{ op: 'move', target: { byFocus: true }, delta: [0, -30] }], s)
    expect(s2.objects[0].y).toBe(70)
  })

  it('move to 绝对坐标按 bbox 中心对齐（points 类图形）', () => {
    const s0 = run([{ op: 'create', shape: 'line', size: 40, at: { x: 100, y: 100 } }])
    const s = run([{ op: 'move', target: { byFocus: true }, to: { x: 512, y: 384 } }], s0)
    const [bx, by, bw] = getBBox(s.objects[0])
    expect(bx + bw / 2).toBe(512)
    expect(by).toBe(384)
  })

  it('delete 移除对象并清空焦点', () => {
    const s0 = run([{ op: 'create', shape: 'circle' }])
    const s = run([{ op: 'delete', target: { byFocus: true } }], s0)
    expect(s.objects).toHaveLength(0)
    expect(s.focusId).toBeUndefined()
  })

  it('style 不改动未指定字段', () => {
    const s0 = run([{ op: 'create', shape: 'circle', fill: '#FF4136', stroke: '#111111' }])
    const s = run([{ op: 'style', target: { byFocus: true }, fill: '#0074D9' }], s0)
    expect(s.objects[0].stroke).toBe('#111111')
  })
})

describe('事务语义（协议 §1.5）', () => {
  it('中途失败保留已成功的 Op，executed 计数正确，入参不被修改', () => {
    const empty = createEmptyScene()
    const r = executeTransaction(empty, [
      { op: 'create', shape: 'circle' },
      { op: 'delete', target: { byName: '不存在' } },
      { op: 'create', shape: 'rect' },
    ])
    expect(r.executed).toBe(1)
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
    expect(r.state.objects).toHaveLength(1) // 第一个 create 保留
    expect(empty.objects).toHaveLength(0) // 纯函数：入参未变
  })

  it('多 Op 事务整体成功（雪人两段身体相互引用 byName）', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 512, y: 500 }, size: 110, fill: '#FFFFFF' },
      { op: 'create', shape: 'circle', name: '头', at: { x: 512, y: 320 }, size: 65, fill: '#FFFFFF' },
      { op: 'style', target: { byName: '头' }, stroke: '#AAAAAA', strokeWidth: 2 },
    ])
    expect(s.objects).toHaveLength(2)
    expect(s.objects[1].stroke).toBe('#AAAAAA')
  })

  it('undo 不属于解释器职责（由 history 层处理），直达解释器返回 UNSUPPORTED_OP', () => {
    const r = executeTransaction(createEmptyScene(), [{ op: 'undo' }])
    expect(r.error?.code).toBe('UNSUPPORTED_OP')
  })
})
