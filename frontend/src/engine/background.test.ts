/**
 * 背景独立成层测试
 *
 * 覆盖：
 * 1. isBackgroundObject 判据（全屏 rect / 小 rect / vpath / 全屏 ellipse）
 * 2. applyAutoGroup：背景对象打标记且 groupId=undefined，主体对象正常编组
 * 3. 回归：整组 move 不波及背景对象（复现 bug 根因）
 */
import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { applyAutoGroup, createHistory, executeWithHistory } from './history'
import { isBackgroundObject, createEmptyScene, type SceneObject, CANVAS_W } from './scene'

// ---------- 测试辅助 ----------

/** 构造最小 SceneObject（仅填测试所需字段） */
function makeObj(overrides: Partial<SceneObject> & { shape: SceneObject['shape'] }): SceneObject {
  const defaults: SceneObject = {
    id: 'rect#1',
    shape: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    z: 1,
    createdSeq: 1,
  }
  return { ...defaults, ...overrides }
}

// ---------- isBackgroundObject 判据 ----------

describe('isBackgroundObject 判据', () => {
  it('全屏 rect（1024×460）→ true：典型背景天空', () => {
    // 以中心定位：x = 1024/2 = 512
    const o = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 230, width: CANVAS_W, height: 460 })
    expect(isBackgroundObject(o)).toBe(true)
  })

  it('全屏 rect（1024×308）→ true：典型背景地面', () => {
    const o = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 614, width: CANVAS_W, height: 308 })
    expect(isBackgroundObject(o)).toBe(true)
  })

  it('小 rect（80×80）→ false：普通装饰矩形', () => {
    const o = makeObj({ id: 'rect#1', shape: 'rect', x: 100, y: 100, width: 80, height: 80 })
    expect(isBackgroundObject(o)).toBe(false)
  })

  it('中等 rect（600×400）→ false：宽度不足 85% 画布宽', () => {
    const o = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 300, width: 600, height: 400 })
    expect(isBackgroundObject(o)).toBe(false)
  })

  it('vpath → false：不是 rect，无论多大', () => {
    const o = makeObj({ id: 'vpath#1', shape: 'vpath', x: 0, y: 0, d: 'M 0 0 L 1024 0 L 1024 768 Z' })
    expect(isBackgroundObject(o)).toBe(false)
  })

  it('全屏 ellipse（1024×460）→ false：只认 rect 形状', () => {
    const o = makeObj({ id: 'ellipse#1', shape: 'ellipse', x: 512, y: 230, radiusX: 512, radiusY: 230 })
    expect(isBackgroundObject(o)).toBe(false)
  })

  it('全宽但高度很小的细条 rect（1024×50）→ false：面积不足 15% 画布', () => {
    const o = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 25, width: CANVAS_W, height: 50 })
    // 面积 = 1024×50 = 51200；画布 15% = 1024×768×0.15 ≈ 118_886 → false
    expect(isBackgroundObject(o)).toBe(false)
  })
})

// ---------- applyAutoGroup 背景隔离 ----------

describe('applyAutoGroup 背景隔离', () => {
  it('背景 rect 不编入主体组，打 background:true，groupId 保持 undefined', () => {
    // 构造 base（seq=0）和 scene（含 2 背景 rect + 3 主体 vpath）
    const base = createEmptyScene()
    // 背景对象：全屏天空
    const sky: SceneObject = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 230, width: 1024, height: 460, createdSeq: 1 })
    // 背景对象：全屏地面
    const ground: SceneObject = makeObj({ id: 'rect#2', shape: 'rect', x: 512, y: 614, width: 1024, height: 308, createdSeq: 2 })
    // 主体 vpath（海绵宝宝各部件，简化）
    const body: SceneObject = makeObj({ id: 'vpath#1', shape: 'vpath', x: 500, y: 400, d: 'M 0 0 L 100 0 L 100 150 Z', createdSeq: 3 })
    const eye: SceneObject = makeObj({ id: 'vpath#2', shape: 'vpath', x: 480, y: 350, d: 'M 0 0 L 20 0 L 10 20 Z', createdSeq: 4 })
    const mouth: SceneObject = makeObj({ id: 'vpath#3', shape: 'vpath', x: 510, y: 420, d: 'M 0 0 L 40 0 L 20 15 Z', createdSeq: 5 })

    const scene = { ...base, objects: [sky, ground, body, eye, mouth], seq: 5 }
    const result = applyAutoGroup(base, scene, '海绵宝宝')

    // 背景对象：background=true，groupId=undefined
    const skyCopy = result.objects.find((o) => o.id === 'rect#1')!
    const groundCopy = result.objects.find((o) => o.id === 'rect#2')!
    expect(skyCopy.background).toBe(true)
    expect(skyCopy.groupId).toBeUndefined()
    expect(groundCopy.background).toBe(true)
    expect(groundCopy.groupId).toBeUndefined()

    // 主体部件：编入同一组
    const bodyCopy = result.objects.find((o) => o.id === 'vpath#1')!
    const eyeCopy = result.objects.find((o) => o.id === 'vpath#2')!
    const mouthCopy = result.objects.find((o) => o.id === 'vpath#3')!
    expect(bodyCopy.groupId).toBe('海绵宝宝')
    expect(eyeCopy.groupId).toBe('海绵宝宝')
    expect(mouthCopy.groupId).toBe('海绵宝宝')
    expect(bodyCopy.background).toBeUndefined()
  })

  it('只有背景对象（无主体部件）→ 背景打标，不编组，无 focusScope 变化', () => {
    const base = createEmptyScene()
    const sky: SceneObject = makeObj({ id: 'rect#1', shape: 'rect', x: 512, y: 230, width: 1024, height: 460, createdSeq: 1 })
    const scene = { ...base, objects: [sky], seq: 1 }
    const result = applyAutoGroup(base, scene, '测试组')
    expect(result.objects[0].background).toBe(true)
    expect(result.objects[0].groupId).toBeUndefined()
    // 不满足编组条件，focusScope 应与原 scene 相同（undefined）
    expect(result.focusScope).toBeUndefined()
  })

  it('只有 1 个主体对象 + 无背景 → 不编组（保持原行为）', () => {
    const base = createEmptyScene()
    const body: SceneObject = makeObj({ id: 'vpath#1', shape: 'vpath', x: 500, y: 400, d: 'M 0 0 L 100 0 Z', createdSeq: 1 })
    const scene = { ...base, objects: [body], seq: 1 }
    const result = applyAutoGroup(base, scene, '测试组')
    expect(result.objects[0].groupId).toBeUndefined()
  })

  it('背景打标后组名占用自动加序号（被背景 groupId 占名是不可能的，但名字冲突仍工作）', () => {
    // 先创建一个已有「主体」组的 base，再新建同名主体应自动加序号
    let h = createHistory()
    h = executeWithHistory(h, [
      { op: 'create', shape: 'circle', name: '部件甲', at: { x: 200, y: 300 }, size: 50 },
      { op: 'create', shape: 'circle', name: '部件乙', at: { x: 400, y: 300 }, size: 50 },
    ], { autoGroupName: '雪人' }).history
    // 第二次画雪人（不含背景），组名应为「雪人2」
    const r = executeWithHistory(h, [
      { op: 'create', shape: 'circle', name: '新部件甲', at: { x: 600, y: 300 }, size: 50 },
      { op: 'create', shape: 'circle', name: '新部件乙', at: { x: 800, y: 300 }, size: 50 },
    ], { autoGroupName: '雪人' })
    const groups = new Set(r.history.scene.objects.map((o) => o.groupId))
    expect(groups.has('雪人')).toBe(true)
    expect(groups.has('雪人2')).toBe(true)
  })
})

// ---------- 回归测试：整组 move 不波及背景（复现 bug 根因） ----------

describe('回归：整组 move 不波及背景对象', () => {
  it('对主体组发出整组 move，主体对象 x 改变，背景对象 x 不变', () => {
    // 先通过 executeWithHistory 构造一个含背景+主体组的场景
    let h = createHistory()

    // 用 create rect 创建全屏背景（模拟 LLM 画的海水背景）
    const r = executeWithHistory(
      h,
      [
        // 全屏背景 rect（中心 x=512，y=230，宽=1024，高=460）
        { op: 'create', shape: 'rect', name: '海水', at: { x: 512, y: 230 }, width: 1024, height: 460 },
        // 主体 vpath（海绵宝宝身体，简化为小 vpath）
        { op: 'create', shape: 'vpath', name: '身体', at: { x: 500, y: 400 }, d: 'M -50 -75 L 50 -75 L 50 75 L -50 75 Z' },
        // 主体 vpath（眼睛）
        { op: 'create', shape: 'vpath', name: '眼睛', at: { x: 480, y: 360 }, d: 'M -15 -15 L 15 -15 L 0 15 Z' },
      ] as Op[],
      { autoGroupName: '海绵宝宝' },
    )
    expect(r.error).toBeUndefined()
    h = r.history

    const bg = h.scene.objects.find((o) => o.name === '海水')!
    const body = h.scene.objects.find((o) => o.name === '身体')!

    // 验证编组结果
    expect(bg.background).toBe(true)
    expect(bg.groupId).toBeUndefined()
    expect(body.groupId).toBe('海绵宝宝')

    const bgXBefore = bg.x
    const bodyXBefore = body.x

    // 通过组名引用执行整组左移：move delta=[-200, 0]
    const moved = executeWithHistory(h, [
      { op: 'move', target: { byName: '海绵宝宝' }, delta: [-200, 0] },
    ])
    expect(moved.error).toBeUndefined()

    const bgAfter = moved.history.scene.objects.find((o) => o.name === '海水')!
    const bodyAfter = moved.history.scene.objects.find((o) => o.name === '身体')!
    const eyeAfter = moved.history.scene.objects.find((o) => o.name === '眼睛')!

    // 背景不受影响：x 不变
    expect(bgAfter.x).toBe(bgXBefore)

    // 主体整组左移：x 应减小约 200（clamp 后可能小于 200，但必须有减小）
    expect(bodyAfter.x).toBeLessThan(bodyXBefore)
    // 眼睛同样左移
    expect(eyeAfter.x).toBeLessThan(h.scene.objects.find((o) => o.name === '眼睛')!.x)
  })
})
