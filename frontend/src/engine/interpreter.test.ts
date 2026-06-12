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
