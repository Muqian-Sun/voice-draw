import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { parseOp } from '../dsl/schema'
import { executeTransaction, resolveTarget, resolveAnchorPoint } from './interpreter'
import { createEmptyScene, getBBox, getCenter, type SceneState } from './scene'

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
    expect(o.fill).toBe('#2D7DD2')
    expect(s.focusId).toBe('circle#1')
  })

  it('v1.7 投影 shadow:true → 默认柔和投影；pattern → 纹理（仅闭合形状）', () => {
    const s = run([{ op: 'create', shape: 'rect', width: 100, height: 80, fill: '#FF4136', shadow: true, pattern: 'stripes' }])
    const o = s.objects[0]
    expect(o.shadow).toEqual({ color: '#1a1410', blur: 14, offsetX: 0, offsetY: 7, opacity: 0.3 })
    expect(o.pattern).toBe('stripes')
  })

  it('v1.7 投影对象形式并入缺省；style shadow:false 去阴影；线类忽略 pattern', () => {
    let s = run([{ op: 'create', shape: 'circle', name: '球', fill: '#0074D9', shadow: { blur: 20, offset: [3, 9] } }])
    expect(s.objects[0].shadow).toEqual({ color: '#1a1410', blur: 20, offsetX: 3, offsetY: 9, opacity: 0.3 })
    s = run([{ op: 'style', target: { byName: '球' }, shadow: false }], s)
    expect(s.objects[0].shadow).toBeUndefined()
    const l = run([{ op: 'create', shape: 'line', points: [[0, 0], [40, 0]], pattern: 'dots' }])
    expect(l.objects[0].pattern).toBeUndefined() // 线类不吃 pattern
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

describe('修改类操作补全（resize/rotate/rename/setText/zorder/focus/export）', () => {
  it('resize scale：圆半径 80 × 1.3 = 104，焦点跟随', () => {
    const s0 = run([{ op: 'create', shape: 'circle' }])
    const s = run([{ op: 'resize', target: { byFocus: true }, scale: 1.3 }], s0)
    expect(s.objects[0].radius).toBeCloseTo(104)
    expect(s.focusId).toBe('circle#1')
  })

  it('resize scale 作用于矩形宽高与线 points', () => {
    const s0 = run([
      { op: 'create', shape: 'rect', at: { x: 512, y: 384 } },
      { op: 'create', shape: 'line', at: { x: 200, y: 200 } },
    ])
    const s = run(
      [
        { op: 'resize', target: { byQuery: { shape: 'rect' } }, scale: 2 },
        { op: 'resize', target: { byQuery: { shape: 'line' } }, scale: 0.5 },
      ],
      s0,
    )
    expect([s.objects[0].width, s.objects[0].height]).toEqual([320, 240])
    expect(s.objects[1].points).toEqual([-60, 0, 60, 0]) // 3v=240 → 120
  })

  it('resize to：rect 显式宽高；相对尺寸 factor（和圆一样宽）', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: '圆', size: 100, at: { x: 300, y: 300 } },
      { op: 'create', shape: 'rect', at: { x: 600, y: 300 } },
    ])
    const s = run(
      [{ op: 'resize', target: { byQuery: { shape: 'rect' } }, to: { width: { relativeTo: { byName: '圆' }, factor: 1 } } }],
      s0,
    )
    expect(s.objects[1].width).toBe(200) // 圆 bbox 宽 = 2r = 200
  })

  it('resize 超出画布拉回（§5.5 clamp）', () => {
    const s0 = run([{ op: 'create', shape: 'circle', size: 100, at: { x: 80, y: 80 } }])
    const r = executeTransaction(s0, [{ op: 'resize', target: { byFocus: true }, scale: 2 }])
    expect(r.error).toBeUndefined()
    const o = r.state.objects[0]
    expect(o.x - o.radius!).toBeGreaterThanOrEqual(0)
    expect(o.y - o.radius!).toBeGreaterThanOrEqual(0)
    expect(r.notices?.[0]).toContain('clamp')
  })

  it('rotate 累加并归一化到 [0,360)', () => {
    const s0 = run([{ op: 'create', shape: 'triangle' }])
    const s1 = run([{ op: 'rotate', target: { byFocus: true }, degrees: 45 }], s0)
    expect(s1.objects[0].rotation).toBe(45)
    const s2 = run([{ op: 'rotate', target: { byFocus: true }, degrees: -90 }], s1)
    expect(s2.objects[0].rotation).toBe(315)
  })

  it('rename 设置 name，byName 随后可命中', () => {
    const s0 = run([{ op: 'create', shape: 'rect' }])
    const s = run(
      [
        { op: 'rename', target: { byFocus: true }, name: '屋顶' },
        { op: 'style', target: { byName: '屋顶' }, fill: '#B22222' },
      ],
      s0,
    )
    expect(s.objects[0].name).toBe('屋顶')
    expect(s.objects[0].fill).toBe('#B22222')
  })

  it('setText 仅对 text 形状有效', () => {
    const s0 = run([{ op: 'create', shape: 'text', text: '你好' }])
    const s = run([{ op: 'setText', target: { byFocus: true }, text: '再见' }], s0)
    expect(s.objects[0].text).toBe('再见')
    const s1 = run([{ op: 'create', shape: 'circle' }])
    const r = executeTransaction(s1, [{ op: 'setText', target: { byFocus: true }, text: 'x' }])
    expect(r.error?.code).toBe('INVALID_OP')
  })

  it('zorder front/back/forward', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: 'a' },
      { op: 'create', shape: 'circle', name: 'b', at: { x: 300, y: 300 } },
      { op: 'create', shape: 'circle', name: 'c', at: { x: 600, y: 300 } },
    ])
    const zOf = (s: SceneState, n: string) => s.objects.find((o) => o.name === n)!.z
    const s1 = run([{ op: 'zorder', target: { byName: 'a' }, to: 'front' }], s0)
    expect(zOf(s1, 'a')).toBeGreaterThan(zOf(s1, 'c'))
    const s2 = run([{ op: 'zorder', target: { byName: 'c' }, to: 'back' }], s0)
    expect(zOf(s2, 'c')).toBeLessThan(zOf(s2, 'a'))
    const s3 = run([{ op: 'zorder', target: { byName: 'a' }, to: 'forward' }], s0)
    expect(zOf(s3, 'a')).toBe(zOf(s0, 'b'))
    expect(zOf(s3, 'b')).toBe(zOf(s0, 'a'))
  })

  it('focus 仅切换焦点，不改对象', () => {
    const s0 = run([
      { op: 'create', shape: 'circle' },
      { op: 'create', shape: 'rect', at: { x: 200, y: 200 } },
    ])
    const s = run([{ op: 'focus', target: { byQuery: { shape: 'circle' } } }], s0)
    expect(s.focusId).toBe('circle#1')
    expect(s.objects).toEqual(s0.objects)
  })

  it('export 不改状态（history 不产生快照）', () => {
    const r = executeTransaction(run([{ op: 'create', shape: 'circle' }]), [{ op: 'export', format: 'png' }])
    expect(r.executed).toBe(1)
    expect(r.notices?.[0]).toContain('导出')
  })
})

describe('焦点更新规则逐条（§5.1 表格）', () => {
  it('事务含多个 create → 焦点 = 最后一个 create 的对象', () => {
    const s = run([
      { op: 'create', shape: 'circle' },
      { op: 'create', shape: 'rect', at: { x: 200, y: 200 } },
    ])
    expect(s.focusId).toBe('rect#1')
  })

  it('修改类操作（style/move/resize/rotate/rename）→ 焦点 = 被操作对象', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: 'a' },
      { op: 'create', shape: 'rect', name: 'b', at: { x: 200, y: 200 } },
    ])
    for (const op of [
      { op: 'style', target: { byName: 'a' }, fill: '#FFDC00' },
      { op: 'move', target: { byName: 'a' }, delta: [10, 0] },
      { op: 'resize', target: { byName: 'a' }, scale: 1.1 },
      { op: 'rotate', target: { byName: 'a' }, degrees: 10 },
      { op: 'rename', target: { byName: 'a' }, name: 'a' },
    ] as const) {
      expect(run([op as Op], s0).focusId).toBe('circle#1')
    }
  })

  it('delete / clear → 焦点清空；focus → 显式设置', () => {
    const s0 = run([
      { op: 'create', shape: 'circle' },
      { op: 'create', shape: 'rect', at: { x: 200, y: 200 } },
    ])
    expect(run([{ op: 'delete', target: { byQuery: { shape: 'rect' } } }], s0).focusId).toBeUndefined()
    expect(run([{ op: 'clear' }], s0).focusId).toBeUndefined()
    expect(run([{ op: 'focus', target: { byQuery: { shape: 'circle' } } }], s0).focusId).toBe('circle#1')
  })
})

describe('group 引用语义（§5.6）', () => {
  const grouped = () =>
    run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 500, y: 500 }, size: 100 },
      { op: 'create', shape: 'circle', name: '头', at: { x: 500, y: 330 }, size: 60 },
      { op: 'create', shape: 'rect', name: '别的', at: { x: 100, y: 100 }, size: 30 },
      { op: 'group', targets: [{ byName: '身体' }, { byName: '头' }], name: '雪人' },
    ])

  it('group 赋 groupId，焦点=最后成员；成员不足 2 报 INVALID_OP', () => {
    const s = grouped()
    expect(s.objects.filter((o) => o.groupId === '雪人')).toHaveLength(2)
    expect(s.objects.find((o) => o.name === '别的')!.groupId).toBeUndefined()
    expect(s.focusId).toBe('circle#2')
    const r = executeTransaction(s, [{ op: 'group', targets: [{ byName: '别的' }, { byName: '别的' }] }])
    expect(r.error?.code).toBe('INVALID_OP')
  })

  it('成员名命中 → 仅作用成员（§5.6 v1.1："把头往右移"只移头）', () => {
    const s0 = grouped()
    const s = run([{ op: 'move', target: { byName: '头' }, delta: [100, 0] }], s0)
    const body = s.objects.find((o) => o.name === '身体')!
    const head = s.objects.find((o) => o.name === '头')!
    expect(body.x).toBe(500) // 身体不动
    expect(head.x).toBe(600)
  })

  it('byFocus 指代 → 整组（"把它移走"，Golden #30 语义）', () => {
    const s0 = grouped() // group 后焦点=最后成员 circle#2（头）
    const s = run([{ op: 'move', target: { byFocus: true }, delta: [100, 0] }], s0)
    expect(s.objects.find((o) => o.name === '身体')!.x).toBe(600)
    expect(s.objects.find((o) => o.name === '头')!.x).toBe(600)
  })

  it('byName 可指组名（"把雪人移到右边"整组移动）', () => {
    const s0 = grouped()
    const s = run([{ op: 'move', target: { byName: '雪人' }, delta: [50, 0] }], s0)
    expect(s.objects.find((o) => o.name === '身体')!.x).toBe(550)
    expect(s.objects.find((o) => o.name === '头')!.x).toBe(550)
  })

  it('resize 整组（组名引用）：几何缩放 + 成员中心绕组中心收放', () => {
    const s0 = grouped()
    const s = run([{ op: 'resize', target: { byName: '雪人' }, scale: 0.5 }], s0)
    const body = s.objects.find((o) => o.name === '身体')!
    const head = s.objects.find((o) => o.name === '头')!
    expect(body.radius).toBe(50)
    expect(head.radius).toBe(30)
    // 组中心 y=(500-100+330-60... union: body[400,600] head[270,390] → y∈[270,600] 中心 435
    expect(body.y).toBeCloseTo(435 + (500 - 435) * 0.5)
    expect(head.y).toBeCloseTo(435 + (330 - 435) * 0.5)
  })

  it('外观类作用于成员本身："把头涂红"不影响身体', () => {
    const s0 = grouped()
    const s = run([{ op: 'style', target: { byName: '头' }, fill: '#FF4136' }], s0)
    expect(s.objects.find((o) => o.name === '头')!.fill).toBe('#FF4136')
    expect(s.objects.find((o) => o.name === '身体')!.fill).not.toBe('#FF4136')
  })

  it('byQuery 组内外都命中时优先组外独立对象', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: 'a', at: { x: 300, y: 300 } },
      { op: 'create', shape: 'circle', name: 'b', at: { x: 600, y: 300 } },
      { op: 'create', shape: 'circle', name: 'c', at: { x: 800, y: 300 } },
      { op: 'group', targets: [{ byName: 'a' }, { byName: 'b' }] },
    ])
    // 组外只有 c → byQuery circle 唯一命中 c，不报歧义
    const s = run([{ op: 'style', target: { byQuery: { shape: 'circle' } }, fill: '#FFDC00' }], s0)
    expect(s.objects.find((o) => o.name === 'c')!.fill).toBe('#FFDC00')
    expect(s.objects.find((o) => o.name === 'a')!.fill).not.toBe('#FFDC00')
  })

  it('delete 整组（组名）；成员名只删成员；ungroup 解组保留 id/name', () => {
    const s0 = grouped()
    const deleted = run([{ op: 'delete', target: { byName: '雪人' } }], s0)
    expect(deleted.objects.map((o) => o.name)).toEqual(['别的'])
    const delMember = run([{ op: 'delete', target: { byName: '头' } }], s0)
    expect(delMember.objects.map((o) => o.name).sort()).toEqual(['别的', '身体'])
    const ungrouped = run([{ op: 'ungroup', target: { byName: '雪人' } }], s0)
    expect(ungrouped.objects.every((o) => o.groupId === undefined)).toBe(true)
    expect(ungrouped.objects.map((o) => o.name).sort()).toEqual(['别的', '头', '身体'])
  })

  it('zorder front 整组（组名）保持组内顺序压到最上层', () => {
    const s0 = grouped()
    const s = run([{ op: 'zorder', target: { byName: '雪人' }, to: 'front' }], s0)
    const zOf = (n: string) => s.objects.find((o) => o.name === n)!.z
    expect(zOf('身体')).toBeGreaterThan(zOf('别的'))
    expect(zOf('头')).toBeGreaterThan(zOf('身体')) // 组内相对顺序保持
  })
})

describe('对象内贴 inside（§5.3 v1.1）', () => {
  it('门嵌在房子底边：bbox 底边贴齐（gap 缺省 0），水平居中', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '房子', at: { x: 512, y: 400 }, width: 200, height: 180 },
      { op: 'create', shape: 'rect', name: '门', at: { ref: { byName: '房子' }, anchor: 'bottom', inside: true }, width: 50, height: 80 },
    ])
    const house = s.objects.find((o) => o.name === '房子')!
    const door = s.objects.find((o) => o.name === '门')!
    expect(door.y + 80 / 2).toBe(house.y + 180 / 2) // 底边贴齐
    expect(door.x).toBe(house.x) // 水平居中
  })

  it('窗在房子内部角落：gap 作内边距', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '房子', at: { x: 512, y: 400 }, width: 200, height: 180 },
      { op: 'create', shape: 'rect', name: '窗', at: { ref: { byName: '房子' }, anchor: 'top-left', inside: true, gap: 15 }, width: 40, height: 40 },
    ])
    const house = s.objects.find((o) => o.name === '房子')!
    const win = s.objects.find((o) => o.name === '窗')!
    expect(win.x - 20).toBe(house.x - 100 + 15) // 左边缘 = 房子左 + 15
    expect(win.y - 20).toBe(house.y - 90 + 15)
  })

  it('无 inside 仍为外贴（既有语义不变）', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '房子', at: { x: 512, y: 400 }, width: 200, height: 180 },
      { op: 'create', shape: 'rect', name: '招牌', at: { ref: { byName: '房子' }, anchor: 'bottom' }, width: 50, height: 30 },
    ])
    const house = s.objects.find((o) => o.name === '房子')!
    const sign = s.objects.find((o) => o.name === '招牌')!
    expect(sign.y - 15).toBe(house.y + 90 + 20) // 上边 = 房子底 + gap 20
  })

  it('move.to 同样支持 inside（把门挪到房子右下角内侧）', () => {
    const s0 = run([
      { op: 'create', shape: 'rect', name: '房子', at: { x: 512, y: 400 }, width: 200, height: 180 },
      { op: 'create', shape: 'rect', name: '门', at: { x: 100, y: 100 }, width: 50, height: 80 },
    ])
    const s = run([{ op: 'move', target: { byName: '门' }, to: { ref: { byName: '房子' }, anchor: 'bottom-right', inside: true } }], s0)
    const house = s.objects.find((o) => o.name === '房子')!
    const door = s.objects.find((o) => o.name === '门')!
    expect(door.x + 25).toBe(house.x + 100)
    expect(door.y + 40).toBe(house.y + 90)
  })
})

describe('line 首端点锚定（§5.3 v1.2）', () => {
  it('手臂长在身体上：显式 points 的线，首端点贴参照 bbox 锚点（gap 缺省 0）', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 500, y: 400 }, size: 100 },
      { op: 'create', shape: 'line', name: '左臂', at: { ref: { byName: '身体' }, anchor: 'left' }, points: [[0, 0], [-70, -40]] },
    ])
    const arm = s.objects.find((o) => o.name === '左臂')!
    // 首端点 = (arm.x + points[0], arm.y + points[1]) 应落在身体 bbox 左缘垂直中点 (400, 400)
    expect(arm.x + arm.points![0]).toBe(400)
    expect(arm.y + arm.points![1]).toBe(400)
  })

  it('无显式 points 的横线维持 bbox 外贴（既有语义不变）', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 500, y: 400 }, size: 100 },
      { op: 'create', shape: 'line', name: '横线', at: { ref: { byName: '身体' }, anchor: 'right' } },
    ])
    const line = s.objects.find((o) => o.name === '横线')!
    // 默认长 3v=240，bbox 左缘 = 身体右缘 + gap 20 → 600+20=620；线中心 x = 620+120
    expect(line.x).toBe(740)
  })

  it('move.to 对显式 points 线同样端点贴合', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 500, y: 400 }, size: 100 },
      { op: 'create', shape: 'line', name: '臂', at: { x: 100, y: 100 }, points: [[0, 0], [70, -40]] },
    ])
    const s = run([{ op: 'move', target: { byName: '臂' }, to: { ref: { byName: '身体' }, anchor: 'right' } }], s0)
    const arm = s.objects.find((o) => o.name === '臂')!
    expect(arm.x + arm.points![0]).toBe(600)
    expect(arm.y + arm.points![1]).toBe(400)
  })
})

describe('onEdge 边缘贴附（§5.3 v1.3）', () => {
  it('猫耳贴圆头：中心钉在圆周 top-left 方向交点（dist=半径）', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 350 }, size: 100 },
      { op: 'create', shape: 'triangle', name: '左耳', size: 30, at: { ref: { byName: '头' }, anchor: 'top-left', onEdge: true } },
    ])
    const ear = s.objects.find((o) => o.name === '左耳')!
    // 三角形 (x,y) 是外接圆心，bbox 中心略低；bbox 中心应在圆周外 halfExt/3 处（1/3 咬合）
    const cx = ear.x
    const cy = ear.y - 0.25 * ear.radius!
    const w = Math.sqrt(3) * ear.radius!
    const h = 1.5 * ear.radius!
    const halfExt = (w / 2) * Math.SQRT1_2 + (h / 2) * Math.SQRT1_2
    expect(Math.hypot(cx - 400, cy - 350)).toBeCloseTo(100 + halfExt / 3, 0)
  })

  it('矩形参照：right 方向钉在右边缘中点；gap 沿方向外移', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '车身', at: { x: 500, y: 400 }, width: 200, height: 100 },
      { op: 'create', shape: 'circle', name: '轮', size: 20, at: { ref: { byName: '车身' }, anchor: 'bottom', onEdge: true } },
      { op: 'create', shape: 'circle', name: '灯', size: 10, at: { ref: { byName: '车身' }, anchor: 'right', onEdge: true, gap: 5 } },
    ])
    const wheel = s.objects.find((o) => o.name === '轮')!
    expect(wheel.x).toBe(500)
    expect(wheel.y).toBeCloseTo(450 + 20 / 3, 1) // 底边中点外移 r/3（1/3 咬合）
    const light = s.objects.find((o) => o.name === '灯')!
    expect(light.x).toBeCloseTo(605 + 10 / 3, 1) // 右缘 + gap5 + r/3
    expect(light.y).toBe(400)
  })

  it('move.to 同样支持 onEdge（把耳朵贴回头上）', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 350 }, size: 100 },
      { op: 'create', shape: 'circle', name: '耳', size: 25, at: { x: 100, y: 100 } },
    ])
    const s = run([{ op: 'move', target: { byName: '耳' }, to: { ref: { byName: '头' }, anchor: 'top-right', onEdge: true } }], s0)
    const ear = s.objects.find((o) => o.name === '耳')!
    expect(Math.hypot(ear.x - 400, ear.y - 350)).toBeCloseTo(100 + (25 * Math.SQRT2) / 3, 0) // 半径 + 对角向 halfExt/3
  })
})

describe('v1.5 表达力扩展', () => {
  it('mirror：右耳 = 左耳关于头的左右镜像（位置精确对称）', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 100 },
      { op: 'create', shape: 'triangle', name: '左耳', size: 30, at: { ref: { byName: '头' }, anchor: 'top-left', onEdge: true } },
      { op: 'mirror', target: { byName: '左耳' }, about: { byName: '头' }, name: '右耳' },
    ])
    const head = s.objects.find((o) => o.name === '头')!
    const earL = s.objects.find((o) => o.name === '左耳')!
    const earR = s.objects.find((o) => o.name === '右耳')!
    expect(earR.name).toBe('右耳')
    expect(earR.y).toBe(earL.y) // 同高
    expect(earR.x - head.x).toBeCloseTo(head.x - earL.x) // 关于头中心 x 对称
  })

  it('mirror horizontal：上下镜像翻 y', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '身体', at: { x: 400, y: 400 }, size: 100 },
      { op: 'create', shape: 'circle', name: '上点', at: { x: 400, y: 300 }, size: 10 },
      { op: 'mirror', target: { byName: '上点' }, about: { byName: '身体' }, axis: 'horizontal' },
    ])
    const m = s.objects.find((o) => o.name === '上点-镜像')!
    expect(m.x).toBe(400)
    expect(m.y).toBe(500) // 400 关于 y=400 镜像
  })

  it('between：脖子落在头和身体中点；t 可调', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 50 },
      { op: 'create', shape: 'circle', name: '身体', at: { x: 400, y: 500 }, size: 80 },
      { op: 'create', shape: 'rect', name: '脖子', at: { between: [{ byName: '头' }, { byName: '身体' }] }, width: 30, height: 40 },
    ])
    const neck = s.objects.find((o) => o.name === '脖子')!
    expect([neck.x, neck.y]).toEqual([400, 400]) // 中点
  })

  it('align x：三个对象中心 x 对齐到首个', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: 'a', at: { x: 300, y: 100 }, size: 10 },
      { op: 'create', shape: 'circle', name: 'b', at: { x: 500, y: 200 }, size: 10 },
      { op: 'create', shape: 'circle', name: 'c', at: { x: 700, y: 300 }, size: 10 },
      { op: 'align', targets: [{ byName: 'a' }, { byName: 'b' }, { byName: 'c' }], axis: 'x' },
    ])
    expect(s.objects.filter((o) => ['a', 'b', 'c'].includes(o.name!)).map((o) => o.x)).toEqual([300, 300, 300])
  })

  it('distribute y：首尾不动，中间等距', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: 'a', at: { x: 400, y: 100 }, size: 10 },
      { op: 'create', shape: 'circle', name: 'b', at: { x: 400, y: 150 }, size: 10 },
      { op: 'create', shape: 'circle', name: 'c', at: { x: 400, y: 500 }, size: 10 },
      { op: 'distribute', targets: [{ byName: 'a' }, { byName: 'b' }, { byName: 'c' }], axis: 'y' },
    ])
    const ys = ['a', 'b', 'c'].map((n) => s.objects.find((o) => o.name === n)!.y)
    expect(ys).toEqual([100, 300, 500]) // b 移到中点
  })

  it('连接线 from/to：line 端点贴双方真实边缘', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '左', at: { x: 200, y: 300 }, size: 50 },
      { op: 'create', shape: 'circle', name: '右', at: { x: 600, y: 300 }, size: 50 },
      { op: 'create', shape: 'line', name: '连线', from: { byName: '左' }, to: { byName: '右' } },
    ])
    const line = s.objects.find((o) => o.name === '连线')!
    const p1 = { x: line.x + line.points![0], y: line.y + line.points![1] }
    const p2 = { x: line.x + line.points![2], y: line.y + line.points![3] }
    expect(p1.x).toBeCloseTo(250) // 左圆右缘 200+50
    expect(p2.x).toBeCloseTo(550) // 右圆左缘 600-50
    expect(p1.y).toBeCloseTo(300)
  })

  it('zorder 相对：把太阳放到云后面（z 落在云之下）', () => {
    const s0 = run([
      { op: 'create', shape: 'circle', name: '太阳', at: { x: 300, y: 200 }, size: 40 },
      { op: 'create', shape: 'circle', name: '云', at: { x: 320, y: 210 }, size: 50 },
    ])
    const s = run([{ op: 'zorder', target: { byName: '太阳' }, to: { below: { byName: '云' } } }], s0)
    const sun = s.objects.find((o) => o.name === '太阳')!
    const cloud = s.objects.find((o) => o.name === '云')!
    expect(sun.z).toBeLessThan(cloud.z)
  })
})

describe('v2.x radial 放射复制', () => {
  // 旋转一个点绕中心（参考 interpreter.ts 里的 rotatePoint）
  function rotPt(px: number, py: number, cx: number, cy: number, deg: number) {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = px - cx
    const dy = py - cy
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
  }

  it('schema 边界：count=1 和 count=65 被拒绝；count=2 和 count=64 通过', () => {
    const base = { op: 'radial' as const, target: { byName: '花瓣' }, about: { x: 512, y: 384 } }
    expect(parseOp({ ...base, count: 1 }).ok).toBe(false)
    expect(parseOp({ ...base, count: 65 }).ok).toBe(false)
    expect(parseOp({ ...base, count: 2 }).ok).toBe(true)
    expect(parseOp({ ...base, count: 64 }).ok).toBe(true)
  })

  it('count=N 产生 N-1 个新对象（总计 N 个含原件），焦点留在原件', () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '花心', at: { x: 400, y: 300 }, size: 30 },
      { op: 'create', shape: 'circle', name: '花瓣', at: { x: 400, y: 180 }, size: 20 },
      { op: 'radial', target: { byName: '花瓣' }, about: { byName: '花心' }, count: 5 },
    ])
    const petals = s.objects.filter((o) => o.name?.startsWith('花瓣'))
    expect(petals).toHaveLength(5) // 原件 + 4 副本
    expect(s.focusId).toBe(s.objects.find((o) => o.name === '花瓣')!.id)
  })

  it('图元 radial，count=3，about 命名对象：副本中心绕花心等角旋转 120/240 度', () => {
    const hubX = 400
    const hubY = 300
    const petalX = 400
    const petalY = 180 // 直接在花心正上方 (offset = -120 in y)

    const s = run([
      { op: 'create', shape: 'circle', name: '花心', at: { x: hubX, y: hubY }, size: 30 },
      { op: 'create', shape: 'circle', name: '花瓣', at: { x: petalX, y: petalY }, size: 20 },
      { op: 'radial', target: { byName: '花瓣' }, about: { byName: '花心' }, count: 3 },
    ])
    const copies = s.objects
      .filter((o) => o.name?.startsWith('花瓣-放射'))
      .sort((a, b) => a.createdSeq - b.createdSeq)
    expect(copies).toHaveLength(2)

    // 每个副本中心 = 原件中心绕花心旋转 k*120 度
    const origCenter = getCenter(s.objects.find((o) => o.name === '花瓣')!)
    for (let k = 1; k <= 2; k++) {
      const expected = rotPt(origCenter.x, origCenter.y, hubX, hubY, k * 120)
      const copyCenter = getCenter(copies[k - 1])
      expect(copyCenter.x).toBeCloseTo(expected.x, 0)
      expect(copyCenter.y).toBeCloseTo(expected.y, 0)
    }
    // rotation 跟随：原件 rotation=0 → 副本 rotation=120,240
    expect(copies[0].rotation).toBeCloseTo(120)
    expect(copies[1].rotation).toBeCloseTo(240)
  })

  it('vpath radial，count=4，about {x,y} 坐标：3 个副本 d 坐标旋转正确', () => {
    // 花瓣 vpath：顶点在花心正上方，三角形形状
    const cx = 512
    const cy = 384
    // 简单的上方花瓣（中心约在 512,284，即花心上方 100px）
    const petalD = 'M512 234 L540 334 L484 334 Z'
    const s = run([
      {
        op: 'create',
        shape: 'vpath',
        name: '花瓣',
        d: petalD,
        fill: '#FF69B4',
      },
      { op: 'radial', target: { byName: '花瓣' }, about: { x: cx, y: cy }, count: 4 },
    ])
    const copies = s.objects
      .filter((o) => o.name?.startsWith('花瓣-放射'))
      .sort((a, b) => a.createdSeq - b.createdSeq)
    expect(copies).toHaveLength(3)

    // 原件 bbox 中心
    const orig = s.objects.find((o) => o.name === '花瓣')!
    const origCenter = getCenter(orig)

    // 验证每个副本的 bbox 中心 ≈ 原件中心绕 (cx,cy) 旋转 k*90 度
    for (let k = 1; k <= 3; k++) {
      const expected = rotPt(origCenter.x, origCenter.y, cx, cy, k * 90)
      const copyCenter = getCenter(copies[k - 1])
      expect(copyCenter.x).toBeCloseTo(expected.x, 0)
      expect(copyCenter.y).toBeCloseTo(expected.y, 0)
    }
  })

  it('about 解析：{x,y} 和 {byName} 两种形式都能正常解析', () => {
    // {x,y} 形式
    const s1 = run([
      { op: 'create', shape: 'circle', name: '点', at: { x: 400, y: 200 }, size: 10 },
      { op: 'radial', target: { byName: '点' }, about: { x: 400, y: 300 }, count: 2 },
    ])
    expect(s1.objects.filter((o) => o.name?.startsWith('点'))).toHaveLength(2)

    // {byName} 形式
    const s2 = run([
      { op: 'create', shape: 'circle', name: '中心', at: { x: 400, y: 300 }, size: 30 },
      { op: 'create', shape: 'circle', name: '点', at: { x: 400, y: 200 }, size: 10 },
      { op: 'radial', target: { byName: '点' }, about: { byName: '中心' }, count: 2 },
    ])
    expect(s2.objects.filter((o) => o.name?.startsWith('点'))).toHaveLength(2)
  })
})

describe('焦点粒度 focusScope（§5.1 v1.1：byFocus 的组/部件二义性）', () => {
  const cat = () =>
    run([
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 80 },
      { op: 'create', shape: 'circle', name: '左眼', at: { x: 380, y: 290 }, size: 8 },
      { op: 'create', shape: 'circle', name: '右眼', at: { x: 420, y: 290 }, size: 8 },
      { op: 'group', targets: [{ byName: '头' }, { byName: '左眼' }, { byName: '右眼' }], name: '猫' },
    ]) // group op 置 focusScope=group（与 llm-plan autoGroup 同语义）

  it('刚画完整组 → focusScope=group；byFocus 作用整组（"把它移走"）', () => {
    const s0 = cat()
    expect(s0.focusScope).toBe('group')
    const s = run([{ op: 'move', target: { byFocus: true }, delta: [100, 0] }], s0)
    expect(s.objects.find((o) => o.name === '头')!.x).toBe(500)
    expect(s.objects.find((o) => o.name === '左眼')!.x).toBe(480) // 整组都动
  })

  it('编辑某部件后 focusScope=object；byFocus 只作用该部件（"它再大点"）', () => {
    const s0 = cat()
    const s1 = run([{ op: 'resize', target: { byName: '左眼' }, scale: 1.5 }], s0)
    expect(s1.focusScope).toBe('object') // 编辑部件后粒度降为对象
    const s2 = run([{ op: 'resize', target: { byFocus: true }, scale: 1.3 }], s1)
    expect(s2.objects.find((o) => o.name === '左眼')!.radius).toBeCloseTo(8 * 1.5 * 1.3)
    expect(s2.objects.find((o) => o.name === '头')!.radius).toBe(80) // 头不受影响
    expect(s2.objects.find((o) => o.name === '右眼')!.radius).toBe(8) // 右眼不受影响
  })

  it('成员名几何操作仍只作用成员；组名仍作用整组（v1.1 不回归）', () => {
    const s0 = cat()
    const sMember = run([{ op: 'move', target: { byName: '左眼' }, delta: [50, 0] }], s0)
    expect(sMember.objects.find((o) => o.name === '头')!.x).toBe(400) // 头不动
    const sGroup = run([{ op: 'move', target: { byName: '猫' }, delta: [50, 0] }], s0)
    expect(sGroup.objects.find((o) => o.name === '头')!.x).toBe(450) // 整组动
  })
})

describe('v1.6 视觉富化（arc / cornerRadius / gradient）', () => {
  it('arc 扇形：size→外半径，缺省 innerRadius 0、angle 270', () => {
    const s = run([{ op: 'create', shape: 'arc', name: '扇', at: { x: 400, y: 300 }, size: 80 }])
    const a = s.objects.find((o) => o.name === '扇')!
    expect([a.radius, a.innerRadius, a.angle]).toEqual([80, 0, 270])
  })

  it('arc 圆环弧：innerRadius>0 + 自定义角度/起始角', () => {
    const s = run([{ op: 'create', shape: 'arc', name: '虹', at: { x: 400, y: 300 }, size: 100, innerRadius: 80, angle: 180, rotation: 180 }])
    const a = s.objects.find((o) => o.name === '虹')!
    expect([a.radius, a.innerRadius, a.angle, a.rotation]).toEqual([100, 80, 180, 180])
  })

  it('rect cornerRadius 透传；非 rect 不带', () => {
    const s = run([
      { op: 'create', shape: 'rect', name: '卡片', at: { x: 300, y: 300 }, width: 100, height: 60, cornerRadius: 12 },
      { op: 'create', shape: 'circle', name: '圆', at: { x: 600, y: 300 }, size: 40, cornerRadius: 12 },
    ])
    expect(s.objects.find((o) => o.name === '卡片')!.cornerRadius).toBe(12)
    expect(s.objects.find((o) => o.name === '圆')!.cornerRadius).toBeUndefined()
  })

  it('gradient 填充：create 时优先于缺省 fill；不并存', () => {
    const s = run([{ op: 'create', shape: 'rect', name: '天空', at: { x: 512, y: 200 }, width: 400, height: 200, gradient: { from: '#87CEEB', to: '#FFFFFF', angle: 90 } }])
    const o = s.objects.find((o) => o.name === '天空')!
    expect(o.gradient).toEqual({ from: '#87CEEB', to: '#FFFFFF', angle: 90 })
    expect(o.fill).toBeUndefined()
  })

  it('style 改渐变；改纯色清除原渐变', () => {
    const s0 = run([{ op: 'create', shape: 'rect', name: '海', at: { x: 512, y: 500 }, width: 400, height: 200, gradient: { from: '#0074D9', to: '#001F3F' } }])
    const s1 = run([{ op: 'style', target: { byName: '海' }, fill: '#0074D9' }], s0)
    expect(s1.objects[0].gradient).toBeUndefined()
    expect(s1.objects[0].fill).toBe('#0074D9')
  })
})

describe('多轮 append：构造类引用 byName 命中多个取最近（修 append 五官丢失停摆）', () => {
  const subject = (fill: string): Op[] => [
    { op: 'create', shape: 'vpath', name: '头', d: 'M232 321 C238 246 303 204 380 216 C453 228 501 284 494 358 C487 432 424 482 346 475 C271 468 226 395 232 321 Z', fill },
    { op: 'create', shape: 'vpath', name: '左耳', d: 'M272 252 C260 190 286 145 330 211 C310 219 292 234 272 252 Z', fill },
    { op: 'mirror', target: { byName: '左耳' }, about: { byName: '头' }, name: '右耳' },
    { op: 'create', shape: 'vpath', name: '左眼', d: 'M305 330 C305 307 322 292 342 302 C361 312 363 342 345 354 C324 368 305 353 305 330 Z', fill: '#111111' },
    { op: 'mirror', target: { byName: '左眼' }, about: { byName: '头' }, name: '右眼' },
  ]

  it('在已有同名部件的画布上再画一个主体：mirror 不再 AMBIGUOUS 停摆，五官全到齐', () => {
    const s1 = run(subject('#F4A340'))
    expect(s1.objects).toHaveLength(5)
    const s2 = run(subject('#888888'), s1) // run 内部断言无 error → 事务未停摆
    expect(s2.objects).toHaveLength(10) // 两主体各 5 件齐全（旧件 + 新件）
    // 第二主体的右耳由其自身（最近）左耳镜像，而非旧件
    const leftEars = s2.objects.filter((o) => o.name === '左耳').sort((a, b) => a.createdSeq - b.createdSeq)
    const rightEars = s2.objects.filter((o) => o.name === '右耳').sort((a, b) => a.createdSeq - b.createdSeq)
    expect(rightEars[1].createdSeq).toBeGreaterThan(leftEars[1].createdSeq)
  })

  it('编辑类 target 仍保留歧义澄清：style 改同名件命中多个 → AMBIGUOUS_TARGET（§5.7 不动）', () => {
    const s1 = executeTransaction(createEmptyScene(), subject('#F4A340')).state
    const s2 = executeTransaction(s1, subject('#888888')).state // 画布上两个「左耳」
    const r = executeTransaction(s2, [{ op: 'style', target: { byName: '左耳' }, fill: '#FF0000' }])
    expect(r.error?.code).toBe('AMBIGUOUS_TARGET')
  })
})

describe('vpath at 相对定位（v2.1）', () => {
  // 父件：50×50 正方形路径，bbox 中心 (225, 225)，底部 y=250
  const SLEEVE_D = 'M200 200 L250 200 L250 250 L200 250 Z'
  // 子件：20×20 小方块，自然 bbox 中心 (410, 410)
  const HAND_D = 'M400 400 L420 400 L420 420 L400 420 Z'

  it('vpath + at 相对定位：子件中心应落在父件底部附近（onEdge 外贴）', () => {
    const s = run([
      { op: 'create', shape: 'vpath', name: '袖', d: SLEEVE_D, fill: '#AAAAAA' },
      {
        op: 'create',
        shape: 'vpath',
        name: '手',
        d: HAND_D,
        fill: '#FFD700',
        at: { ref: { byName: '袖' }, anchor: 'bottom', onEdge: true },
      },
    ])
    const sleeve = s.objects.find((o) => o.name === '袖')!
    const hand = s.objects.find((o) => o.name === '手')!
    // x,y 非 0（相对定位已生效）
    expect(hand.x !== 0 || hand.y !== 0).toBe(true)
    // 手的 bbox 中心 y > 袖的 bbox 中心 y（手在袖子下方）
    const sleeveBBox = getBBox(sleeve)
    const handBBox = getBBox(hand)
    const sleeveCY = sleeveBBox[1] + sleeveBBox[3] / 2
    const handCY = handBBox[1] + handBBox[3] / 2
    expect(handCY).toBeGreaterThan(sleeveCY)
  })

  it('vpath 无 at → x===0 && y===0（向后兼容）', () => {
    const s = run([{ op: 'create', shape: 'vpath', name: '形', d: SLEEVE_D, fill: '#AAAAAA' }])
    const o = s.objects[0]
    expect(o.x).toBe(0)
    expect(o.y).toBe(0)
  })

  it('vpath at 引用不存在目标 → op 失败（TARGET_NOT_FOUND），不崩', () => {
    const r = executeTransaction(createEmptyScene(), [
      {
        op: 'create',
        shape: 'vpath',
        name: '手',
        d: HAND_D,
        fill: '#FFD700',
        at: { ref: { byName: '不存在的袖子' }, anchor: 'bottom' },
      },
    ])
    expect(r.error?.code).toBe('TARGET_NOT_FOUND')
    expect(r.state.objects).toHaveLength(0) // 未建出对象
  })
})

describe('「组名/部件名」限定解析（多角色多轮编辑消歧）', () => {
  // 构建：两个角色组，每组都有一个叫"裙子"的部件
  const multiChar = () => {
    const s = run([
      { op: 'create', shape: 'circle', name: '裙子', fill: '#FF0000', at: { x: 200, y: 300 }, size: 30 },
      { op: 'create', shape: 'circle', name: '头', fill: '#FFD700', at: { x: 200, y: 200 }, size: 25 },
      { op: 'group', targets: [{ byName: '裙子' }, { byName: '头' }], name: '白雪公主' },
      { op: 'create', shape: 'circle', name: '裙子', fill: '#0000FF', at: { x: 700, y: 300 }, size: 30 },
      { op: 'create', shape: 'circle', name: '头', fill: '#888888', at: { x: 700, y: 200 }, size: 25 },
      { op: 'group', targets: [{ byQuery: { shape: 'circle', fill: '#0000FF' } }, { byQuery: { shape: 'circle', fill: '#888888' } }], name: '小矮人1' },
    ])
    return s
  }

  it('byName "白雪公主/裙子" 精确命中白雪公主组内的裙子（fill=#FF0000）', () => {
    const s = multiChar()
    const r = resolveTarget(s, { byName: '白雪公主/裙子' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.obj.fill).toBe('#FF0000')
    expect(r.obj.groupId).toBe('白雪公主')
  })

  it('byName "裙子"（无组限定）→ AMBIGUOUS_TARGET（有两个，行为不变）', () => {
    const s = multiChar()
    const r = resolveTarget(s, { byName: '裙子' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('AMBIGUOUS_TARGET')
  })

  it('byName "白雪公主/不存在" → 回退普通名查找 → TARGET_NOT_FOUND（组名写错容错）', () => {
    const s = multiChar()
    const r = resolveTarget(s, { byName: '白雪公主/不存在' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('TARGET_NOT_FOUND')
  })

  it('style op 通过 "白雪公主/裙子" 只改白雪公主的裙子，不影响小矮人的裙子（无组提升）', () => {
    const s0 = multiChar()
    // 找到小矮人裙子的初始颜色
    const other = s0.objects.find((o) => o.name === '裙子' && o.groupId === '小矮人1')!
    const otherFillBefore = other.fill
    const s = run([{ op: 'style', target: { byName: '白雪公主/裙子' }, fill: '#00FF00' }], s0)
    const snowWhiteDress = s.objects.find((o) => o.name === '裙子' && o.groupId === '白雪公主')!
    const dwarfDress = s.objects.find((o) => o.name === '裙子' && o.groupId === '小矮人1')!
    expect(snowWhiteDress.fill).toBe('#00FF00') // 白雪公主裙子变绿
    expect(dwarfDress.fill).toBe(otherFillBefore) // 小矮人裙子不变
  })
})

// 手（子件）：20×20 vpath，自然 bbox 在绝对坐标 [400,400,20,20]，自然中心 (410,410)
const HAND_D = 'M400 400 L420 400 L420 420 L400 420 Z'    // 20×20, natural center (410,410)

describe('attach op — 持久锚定（几何接地 Phase 1，RFC §6）', () => {
  // 建立一个含 袖（rect）和 手（vpath）的初始场景
  const withSleeve = () =>
    run([
      {
        op: 'create',
        shape: 'rect',
        name: '袖',
        at: { x: 300, y: 300 },
        width: 100,
        height: 100,
        fill: '#AAAAAA',
      },
    ])

  const withSleeveAndHand = () =>
    run(
      [
        {
          op: 'create',
          shape: 'vpath',
          name: '手',
          d: HAND_D,
          fill: '#FFD700',
        },
      ],
      withSleeve(),
    )

  it('全参 attach：vpath 手平移到父件（袖）bottom onEdge 点，anchor 字段写入', () => {
    const s0 = withSleeveAndHand()
    const s = run(
      [
        {
          op: 'attach',
          target: { byName: '手' },
          to: { byName: '袖' },
          parentAnchor: 'bottom',
          mode: 'onEdge',
        },
      ],
      s0,
    )
    const hand = s.objects.find((o) => o.name === '手')!
    const sleeve = s.objects.find((o) => o.name === '袖')!

    // 1. anchor 字段已写入
    expect(hand.anchor).toBeDefined()
    expect(hand.anchor!.to).toEqual({ byName: '袖' })
    expect(hand.anchor!.parentAnchor).toBe('bottom')
    expect(hand.anchor!.mode).toBe('onEdge')

    // 2. 手的 bbox 中心 y 大于袖的 bbox 中心 y（手在袖子下方）
    const sleeveBBox = getBBox(sleeve)
    const handBBox = getBBox(hand)
    const sleeveCY = sleeveBBox[1] + sleeveBBox[3] / 2
    const handCY = handBBox[1] + handBBox[3] / 2
    expect(handCY).toBeGreaterThan(sleeveCY)

    // 3. 手的 bbox 中心 x ≈ 袖的中心 x（水平对齐，onEdge bottom 方向）
    const sleeveCX = sleeveBBox[0] + sleeveBBox[2] / 2
    const handCX = handBBox[0] + handBBox[2] / 2
    expect(Math.abs(handCX - sleeveCX)).toBeLessThan(1)
  })

  it('仅 target reanchor：按已存 anchor 关系重新贴附（修改父件后手跟随）', () => {
    const s0 = withSleeveAndHand()
    // 先用全参 attach 建立关系
    const s1 = run(
      [{ op: 'attach', target: { byName: '手' }, to: { byName: '袖' }, parentAnchor: 'bottom', mode: 'onEdge' }],
      s0,
    )
    const hand1 = s1.objects.find((o) => o.name === '手')!
    const handBBox1 = getBBox(hand1)
    const handCY1 = handBBox1[1] + handBBox1[3] / 2

    // 移动袖子（父件）
    const s2 = run([{ op: 'move', target: { byName: '袖' }, delta: [100, 0] }], s1)

    // 用仅 target 形式重新贴附（让手跟随袖子新位置）
    const s3 = run([{ op: 'attach', target: { byName: '手' } }], s2)
    const hand3 = s3.objects.find((o) => o.name === '手')!
    const handBBox3 = getBBox(hand3)
    const handCX3 = handBBox3[0] + handBBox3[2] / 2

    // 手的 x 中心应跟随袖子向右移动了
    const hand1CX = handBBox1[0] + handBBox1[2] / 2
    expect(handCX3).toBeGreaterThan(hand1CX)
    // anchor 关系不变
    expect(hand3.anchor!.to).toEqual({ byName: '袖' })
    expect(hand3.anchor!.mode).toBe('onEdge')
    // y 方向仍贴袖底（近似相同 y 相对位置）
    const sleeve3 = s3.objects.find((o) => o.name === '袖')!
    const sleeveBBox3 = getBBox(sleeve3)
    const sleeveCY3 = sleeveBBox3[1] + sleeveBBox3[3] / 2
    const handCY3 = handBBox3[1] + handBBox3[3] / 2
    expect(Math.abs(handCY3 - handCY1)).toBeLessThan(1) // y 相对位置不变（袖子只向右移了，没动 y）
    expect(handCY3).toBeGreaterThan(sleeveCY3) // 手仍在袖下方
  })

  it('mode=outside：圆附在方块右外侧（等同于 placeOutside）', () => {
    const s0 = run([
      { op: 'create', shape: 'rect', name: '方块', at: { x: 300, y: 300 }, width: 100, height: 100, fill: '#AAAAAA' },
      { op: 'create', shape: 'circle', name: '圆', size: 20, fill: '#FF0000' },
    ])
    const s = run(
      [{ op: 'attach', target: { byName: '圆' }, to: { byName: '方块' }, parentAnchor: 'right', mode: 'outside' }],
      s0,
    )
    const square = s.objects.find((o) => o.name === '方块')!
    const circle = s.objects.find((o) => o.name === '圆')!
    const squareBBox = getBBox(square)
    const circleBBox = getBBox(circle)
    // 圆的左边缘 >= 方块右边缘（外贴，右侧）
    expect(circleBBox[0]).toBeGreaterThanOrEqual(squareBBox[0] + squareBBox[2] - 1)
    // anchor 字段写入
    expect(circle.anchor!.mode).toBe('outside')
    expect(circle.anchor!.parentAnchor).toBe('right')
  })

  it('mode=inside：小圆附在方块内部顶边（等同于 inside:true）', () => {
    const s0 = run([
      { op: 'create', shape: 'rect', name: '方块', at: { x: 300, y: 300 }, width: 200, height: 200, fill: '#AAAAAA' },
      { op: 'create', shape: 'circle', name: '小圆', size: 20, fill: '#FF0000' },
    ])
    const s = run(
      [{ op: 'attach', target: { byName: '小圆' }, to: { byName: '方块' }, parentAnchor: 'top', mode: 'inside' }],
      s0,
    )
    const square = s.objects.find((o) => o.name === '方块')!
    const circle = s.objects.find((o) => o.name === '小圆')!
    const squareBBox = getBBox(square)
    const circleBBox = getBBox(circle)
    // 小圆在方块内部（小圆上边 >= 方块上边）
    expect(circleBBox[1]).toBeGreaterThanOrEqual(squareBBox[1])
    // 小圆下边 <= 方块下边
    expect(circleBBox[1] + circleBBox[3]).toBeLessThanOrEqual(squareBBox[1] + squareBBox[3])
    expect(circle.anchor!.mode).toBe('inside')
  })

  it('老存档无 anchor 字段：仅 target attach → INVALID_OP（无锚，不崩）', () => {
    const s0 = withSleeveAndHand()
    // 手没有 anchor 字段（刚创建，无锚定关系）
    const r = executeTransaction(s0, [{ op: 'attach', target: { byName: '手' } }])
    expect(r.error?.code).toBe('INVALID_OP')
    expect(r.error?.message).toContain('锚定关系')
  })

  it('schema：全参缺 mode → 被 zod 拒绝（INVALID_OP 前置校验）', () => {
    // 全参形式但缺 mode → superRefine 报错
    const result = parseOp({ op: 'attach', target: { byName: '手' }, to: { byName: '袖' }, parentAnchor: 'bottom' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('mode')
  })

  it('schema：全参缺 parentAnchor → 被 zod 拒绝', () => {
    const result = parseOp({ op: 'attach', target: { byName: '手' }, to: { byName: '袖' }, mode: 'onEdge' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('parentAnchor')
  })

  it('schema：仅 target 形式（不带 to）通过 zod 校验', () => {
    const result = parseOp({ op: 'attach', target: { byName: '手' } })
    expect(result.ok).toBe(true)
  })

  it('schema：全参全字段正确 → zod 通过', () => {
    const result = parseOp({
      op: 'attach',
      target: { byName: '手' },
      to: { byName: '袖' },
      parentAnchor: 'bottom',
      mode: 'onEdge',
      childAnchor: 'center',
      gap: 5,
      offset: [10, 0],
    })
    expect(result.ok).toBe(true)
  })

  it('resolveAnchorPoint：纯函数等同于 resolvePosition（x/y 绝对坐标透传）', () => {
    const state = createEmptyScene()
    const r = resolveAnchorPoint(state, { x: 300, y: 400 }, 100, 80)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.point).toEqual({ x: 300, y: 400 })
  })
})
