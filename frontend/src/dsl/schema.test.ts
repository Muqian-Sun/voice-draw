import { describe, expect, it } from 'vitest'
import { parseOp, parseOps, safeColor, type Op } from './schema'

describe('合法 Op（协议 §1.4）', () => {
  const cases: Array<[string, unknown]> = [
    ['create 最简形式', { op: 'create', shape: 'circle' }],
    [
      'create 全槽位（相对定位 + 语义尺寸）',
      {
        op: 'create',
        shape: 'rect',
        name: '房子',
        at: { ref: 'canvas', anchor: 'top-left', offset: [10, 10], gap: 40 },
        size: 'large',
        fill: '#0074D9',
        stroke: '#111111',
        strokeWidth: 2,
        rotation: 15,
        desc: '画一个房子',
      },
    ],
    [
      'create 相对对象定位 + 相对尺寸（"在房子左边画棵比它矮的树"）',
      {
        op: 'create',
        shape: 'triangle',
        at: { ref: { byName: '房子' }, anchor: 'left', gap: 60 },
        size: { relativeTo: { byName: '房子' }, factor: 0.7 },
        fill: '#2ECC40',
      },
    ],
    ['create 文本', { op: 'create', shape: 'text', text: '你好', fontSize: 24 }],
    ['create 折线（points）', { op: 'create', shape: 'polyline', points: [[0, 0], [100, 0], [100, 50]] }],
    ['create line 可不带 points（由 at+size 推导）', { op: 'create', shape: 'line', size: 80 }],
    ['move delta（"往右移一点"）', { op: 'move', target: { byFocus: true }, delta: [60, 0] }],
    ['move to 绝对坐标', { op: 'move', target: { byName: '太阳' }, to: { x: 900, y: 80 } }],
    ['move to 相对位置', { op: 'move', target: { byId: 'circle#1' }, to: { ref: 'canvas', anchor: 'center' } }],
    ['style 改填充', { op: 'style', target: { byQuery: { shape: 'circle', fill: '#FF4136' } }, fill: '#0074D9' }],
    ['style 改透明度', { op: 'style', target: { byFocus: true }, opacity: 0.5 }],
    ['resize scale（"变大一点"）', { op: 'resize', target: { byFocus: true }, scale: 1.3 }],
    ['resize to 相对尺寸', { op: 'resize', target: { byId: 'rect#2' }, to: { width: { relativeTo: { byName: '房子' }, factor: 0.5 } } }],
    ['rotate 负角度（逆时针）', { op: 'rotate', target: { byQuery: { shape: 'triangle' } }, degrees: -45 }],
    ['setText', { op: 'setText', target: { byFocus: true }, text: '新标题' }],
    ['delete byQuery 序数（"第二个圆"）', { op: 'delete', target: { byQuery: { shape: 'circle', ordinal: 2 } } }],
    ['delete byQuery last', { op: 'delete', target: { byQuery: { ordinal: 'last' } } }],
    ['rename（"这个叫屋顶"）', { op: 'rename', target: { byFocus: true }, name: '屋顶' }],
    ['group 两个对象', { op: 'group', targets: [{ byId: 'circle#1' }, { byId: 'circle#2' }], name: '雪人' }],
    ['ungroup', { op: 'ungroup', target: { byName: '雪人' } }],
    ['zorder（"放到云后面"）', { op: 'zorder', target: { byName: '太阳' }, to: 'back' }],
    ['undo 缺省 1 步', { op: 'undo' }],
    ['undo 多步', { op: 'undo', steps: 3 }],
    ['redo', { op: 'redo' }],
    ['clear', { op: 'clear' }],
    ['focus', { op: 'focus', target: { byQuery: { fill: '#FF4136' } } }],
    ['export png', { op: 'export', format: 'png' }],
  ]

  it.each(cases)('%s', (_name, input) => {
    const r = parseOp(input)
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
  })
})

describe('非法 Op 必须被拒绝', () => {
  const cases: Array<[string, unknown]> = [
    ['未知 op', { op: 'paint', shape: 'circle' }],
    ['create 缺 shape', { op: 'create' }],
    ['create text 缺内容', { op: 'create', shape: 'text' }],
    ['create polyline 缺 points', { op: 'create', shape: 'polyline' }],
    ['create points 少于 2 个点', { op: 'create', shape: 'polyline', points: [[0, 0]] }],
    ['create 负尺寸', { op: 'create', shape: 'circle', size: -10 }],
    ['create 未知字段（strict，radius 不是协议字段）', { op: 'create', shape: 'circle', radius: 50 }],
    ['create 非法 anchor', { op: 'create', shape: 'circle', at: { ref: 'canvas', anchor: 'middle' } }],
    ['create offset 元组长度错误', { op: 'create', shape: 'circle', at: { ref: 'canvas', anchor: 'center', offset: [1, 2, 3] } }],
    ['move 同时给 to 和 delta', { op: 'move', target: { byFocus: true }, to: { x: 1, y: 1 }, delta: [1, 1] }],
    ['move to/delta 都缺', { op: 'move', target: { byFocus: true } }],
    ['move 缺 target', { op: 'move', delta: [60, 0] }],
    ['move target 不接受裸字符串（须用选择器对象）', { op: 'move', target: '太阳', delta: [0, 40] }],
    ['style 无任何样式字段', { op: 'style', target: { byFocus: true } }],
    ['style opacity 越界', { op: 'style', target: { byFocus: true }, opacity: 1.5 }],
    ['resize scale 与 to 都缺', { op: 'resize', target: { byFocus: true } }],
    ['resize to 为空对象', { op: 'resize', target: { byFocus: true }, to: {} }],
    ['resize scale 非正数', { op: 'resize', target: { byFocus: true }, scale: 0 }],
    ['byQuery 空查询', { op: 'delete', target: { byQuery: {} } }],
    ['byFocus 非 true', { op: 'delete', target: { byFocus: false } }],
    ['group 只有 1 个目标', { op: 'group', targets: [{ byId: 'circle#1' }] }],
    ['undo steps 为 0', { op: 'undo', steps: 0 }],
    ['undo steps 非整数', { op: 'undo', steps: 1.5 }],
    ['export 非 png', { op: 'export', format: 'jpg' }],
    ['rotate 缺 degrees', { op: 'rotate', target: { byFocus: true } }],
  ]

  it.each(cases)('%s', (_name, input) => {
    const r = parseOp(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })
})

describe('事务（parseOps，协议 §1.5）', () => {
  it('合法 Op 数组通过', () => {
    const r = parseOps([
      { op: 'create', shape: 'circle', name: '头', fill: '#FFFFFF' },
      { op: 'create', shape: 'circle', name: '身体', at: { ref: { byName: '头' }, anchor: 'bottom' } },
    ])
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (r.ok) expect(r.ops).toHaveLength(2)
  })

  it('空数组拒绝（事务至少 1 个 Op）', () => {
    expect(parseOps([]).ok).toBe(false)
  })

  it('非数组拒绝', () => {
    expect(parseOps({ op: 'undo' }).ok).toBe(false)
  })

  it('数组中任一 Op 非法则整体拒绝，错误信息含下标', () => {
    const r = parseOps([{ op: 'undo' }, { op: 'paint' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('1')
  })
})

describe('zorder 裸名归一（above/below 接受裸字符串）', () => {
  it('above 裸名被归一为 {byName}', () => {
    const r = parseOp({ op: 'zorder', target: { byName: '眼睛' }, to: { above: '头发' } })
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (r.ok) {
      const op = r.op as Extract<Op, { op: 'zorder' }>
      expect(op.to).toEqual({ above: { byName: '头发' } })
    }
  })
})

describe('safeColor（颜色边界降级）', () => {
  // 注意：颜色降级是浏览器侧行为（CSS.supports 存在时生效）。
  // node/vitest 环境无 CSS 全局 → safeColor 透传原值，确保测试环境下 schema 不修改输入。
  it('合法色透传（node 环境无 CSS.supports，始终透传）', () => {
    expect(safeColor('#87CEEB')).toBe('#87CEEB')
  })
  it('单字符 hex 在 node 环境透传（CSS.supports 不存在）', () => {
    expect(safeColor('#a')).toBe('#a')
  })
})

describe('v1.6 schema（arc / gradient / cornerRadius）', () => {
  it('arc 形状合法；gradient/cornerRadius 字段', () => {
    expect(parseOp({ op: 'create', shape: 'arc', size: 80, angle: 180, innerRadius: 40 }).ok).toBe(true)
    expect(parseOp({ op: 'create', shape: 'rect', width: 100, height: 60, cornerRadius: 10 }).ok).toBe(true)
    expect(parseOp({ op: 'create', shape: 'rect', width: 100, height: 200, gradient: { from: '#87CEEB', to: '#fff', angle: 90 } }).ok).toBe(true)
  })

  it('style 可只给 gradient', () => {
    expect(parseOp({ op: 'style', target: { byName: '天空' }, gradient: { from: '#a', to: '#b' } }).ok).toBe(true)
  })

  it('gradient 缺 from/to 非法', () => {
    expect(parseOp({ op: 'create', shape: 'rect', width: 10, height: 10, gradient: { from: '#a' } }).ok).toBe(false)
  })
})
