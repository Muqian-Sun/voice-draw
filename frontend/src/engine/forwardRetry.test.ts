import { describe, it, expect } from 'vitest'
import { createForwardTolerantRunner } from './forwardRetry'
import { createEmptyScene } from './scene'
import type { Op } from '../dsl'

// 引用"头"的眼睛（相对定位 at.ref）——"头"不存在时单 op 执行报 TARGET_NOT_FOUND
const head: Op = { op: 'create', shape: 'circle', name: '头', at: { x: 512, y: 300 }, size: 80 }
const eye: Op = { op: 'create', shape: 'circle', name: '眼', at: { ref: { byName: '头' }, anchor: 'center' }, size: 10 }

describe('forwardRetry — 流式前向引用容忍', () => {
  it('正序（先创建后引用）：依次应用、无暂存', () => {
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(head)
    r.push(eye)
    const fin = r.finish()
    expect(fin.skipped).toHaveLength(0)
    expect(fin.pending).toHaveLength(0)
    expect(fin.state.objects.map((o) => o.name).sort()).toEqual(['头', '眼'])
  })

  it('乱序（引用在前、创建在后）：暂存重试后全部应用（核心回归）', () => {
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(eye) // 头 不存在 → TARGET_NOT_FOUND → 暂存
    r.push(head) // 应用 → flush 重试 眼 → 应用
    const fin = r.finish()
    expect(fin.skipped).toHaveLength(0)
    expect(fin.pending).toHaveLength(0)
    expect(fin.state.objects).toHaveLength(2)
  })

  it('应用顺序由依赖决定：暂存的引用 op 在其依赖之后才回调', () => {
    const applied: string[] = []
    const r = createForwardTolerantRunner(createEmptyScene(), (op) => {
      applied.push(op.op === 'create' ? (op.name ?? '?') : op.op)
    })
    r.push(eye) // 暂存
    r.push(head) // 应用 头 → flush 应用 眼
    r.finish()
    expect(applied).toEqual(['头', '眼']) // 头先、眼后（被暂存）
  })

  it('链式依赖 C→B→A 完全逆序：仍收敛到全部应用', () => {
    const a: Op = { op: 'create', shape: 'circle', name: 'A', at: { x: 200, y: 200 }, size: 60 }
    const b: Op = { op: 'create', shape: 'circle', name: 'B', at: { ref: { byName: 'A' }, anchor: 'right' }, size: 40 }
    const c: Op = { op: 'create', shape: 'circle', name: 'C', at: { ref: { byName: 'B' }, anchor: 'right' }, size: 30 }
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(c) // 暂存（B 无）
    r.push(b) // 暂存（A 无）
    r.push(a) // 应用 A → flush：B 应用 → 再 flush：C 应用
    const fin = r.finish()
    expect(fin.pending).toHaveLength(0)
    expect(fin.state.objects.map((o) => o.name).sort()).toEqual(['A', 'B', 'C'])
  })

  it('真·悬空引用（依赖始终未创建）：流毕留在 pending、不污染场景', () => {
    const ghost: Op = { op: 'create', shape: 'circle', name: '眼', at: { ref: { byName: '不存在' }, anchor: 'center' }, size: 10 }
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(ghost)
    const fin = r.finish()
    expect(fin.skipped).toHaveLength(0)
    expect(fin.pending).toHaveLength(1)
    expect(fin.state.objects).toHaveLength(0)
  })

  it('mirror 前向引用（about/target 尚未创建）：暂存重试后镜像成功', () => {
    const leftEar: Op = { op: 'create', shape: 'circle', name: '左耳', at: { x: 470, y: 250 }, size: 20 }
    const headOp: Op = { op: 'create', shape: 'circle', name: '头', at: { x: 512, y: 300 }, size: 80 }
    const rightEar: Op = { op: 'mirror', target: { byName: '左耳' }, about: { byName: '头' }, name: '右耳' }
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(rightEar) // 左耳/头 都无 → 暂存
    r.push(leftEar) // 应用；flush 时头仍无 → 右耳留暂存
    r.push(headOp) // 应用；flush → 右耳镜像成功
    const fin = r.finish()
    expect(fin.pending).toHaveLength(0)
    const names = fin.state.objects.map((o) => o.name)
    expect(names).toHaveLength(3)
    expect(names).toEqual(expect.arrayContaining(['左耳', '头', '右耳']))
  })

  it('歧义 op（AMBIGUOUS_TARGET）软跳过：保留已画部分、不清空整幅（核心回归）', () => {
    // 模拟"持久化场景里画布已有同名对象"：两个都叫"圆"，随后某 op 按名引用 → 歧义
    const c1: Op = { op: 'create', shape: 'circle', name: '圆', at: { x: 200, y: 200 }, size: 40 }
    const c2: Op = { op: 'create', shape: 'circle', name: '圆', at: { x: 400, y: 200 }, size: 40 }
    const styleAmbig: Op = { op: 'style', target: { byName: '圆' }, fill: '#FF4136' } // style 非 preferRecent → 2 命中歧义
    const r = createForwardTolerantRunner(createEmptyScene())
    r.push(c1)
    r.push(c2)
    r.push(styleAmbig) // 歧义 → 软跳过，不中止
    const fin = r.finish()
    expect(fin.skipped).toHaveLength(1)
    expect(fin.skipped[0].error.code).toBe('AMBIGUOUS_TARGET')
    expect(fin.pending).toHaveLength(0)
    expect(fin.state.objects).toHaveLength(2) // 两个圆仍在，未被清空
  })
})
