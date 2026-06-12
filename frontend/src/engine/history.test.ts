import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { executeTransaction } from './interpreter'
import { commitIncremental, createHistory, executeWithHistory, MAX_UNDO_DEPTH, type HistoryState } from './history'

/** 测试辅助：依次执行多个事务，断言无错误 */
function runAll(transactions: Op[][], from?: HistoryState): HistoryState {
  let h = from ?? createHistory()
  for (const ops of transactions) {
    const r = executeWithHistory(h, ops)
    expect(r.error, r.error?.message).toBeUndefined()
    h = r.history
  }
  return h
}

const createCircle = (name?: string): Op => ({ op: 'create', shape: 'circle', ...(name ? { name } : {}) })

describe('undo/redo 基础（规格 §5.4）', () => {
  it('undo 整体回退一个多 Op 事务（"画雪人→撤销"语义）', () => {
    const h = runAll([
      [createCircle('身体'), createCircle('头'), { op: 'style', target: { byName: '头' }, fill: '#FFFFFF' }],
    ])
    expect(h.scene.objects).toHaveLength(2)
    const r = executeWithHistory(h, [{ op: 'undo' }])
    expect(r.error).toBeUndefined()
    expect(r.history.scene.objects).toHaveLength(0)
    expect(r.steps).toBe(1)
  })

  it('undo 恢复快照中的焦点（§5.1）', () => {
    const h = runAll([[createCircle('甲')], [{ op: 'delete', target: { byName: '甲' } }]])
    expect(h.scene.focusId).toBeUndefined()
    const r = executeWithHistory(h, [{ op: 'undo' }])
    expect(r.history.scene.focusId).toBe('circle#1') // delete 前焦点是新建的圆
  })

  it('redo 重做被撤销的事务', () => {
    const h = runAll([[createCircle()]])
    const undone = executeWithHistory(h, [{ op: 'undo' }]).history
    expect(undone.scene.objects).toHaveLength(0)
    const redone = executeWithHistory(undone, [{ op: 'redo' }])
    expect(redone.error).toBeUndefined()
    expect(redone.history.scene.objects).toHaveLength(1)
  })

  it('undo steps:n 多步回退；超过可用深度撤到栈底不报错', () => {
    const h = runAll([[createCircle()], [createCircle()]])
    const r = executeWithHistory(h, [{ op: 'undo', steps: 5 }])
    expect(r.error).toBeUndefined()
    expect(r.steps).toBe(2)
    expect(r.history.scene.objects).toHaveLength(0)
  })

  it('栈空 undo → NOTHING_TO_UNDO；栈空 redo → NOTHING_TO_REDO', () => {
    const h = createHistory()
    expect(executeWithHistory(h, [{ op: 'undo' }]).error?.code).toBe('NOTHING_TO_UNDO')
    expect(executeWithHistory(h, [{ op: 'redo' }]).error?.code).toBe('NOTHING_TO_REDO')
  })

  it('undo/redo 与其他 Op 混合 → INVALID_OP（协议 §1.5）', () => {
    const h = runAll([[createCircle()]])
    const r = executeWithHistory(h, [{ op: 'undo' }, createCircle()])
    expect(r.error?.code).toBe('INVALID_OP')
    expect(r.history).toBe(h) // 原状态不变
  })
})

describe('redo 栈失效与快照策略', () => {
  it('新事务提交后 redo 栈清空', () => {
    const h = runAll([[createCircle()]])
    const undone = executeWithHistory(h, [{ op: 'undo' }]).history
    const diverged = executeWithHistory(undone, [{ op: 'create', shape: 'rect' }]).history
    expect(executeWithHistory(diverged, [{ op: 'redo' }]).error?.code).toBe('NOTHING_TO_REDO')
  })

  it('完全失败的事务（executed=0）不入栈、redo 栈保留', () => {
    const h = runAll([[createCircle()]])
    const undone = executeWithHistory(h, [{ op: 'undo' }]).history
    const failed = executeWithHistory(undone, [{ op: 'delete', target: { byName: '不存在' } }])
    expect(failed.error?.code).toBe('TARGET_NOT_FOUND')
    // redo 仍然可用
    const redone = executeWithHistory(failed.history, [{ op: 'redo' }])
    expect(redone.error).toBeUndefined()
    expect(redone.history.scene.objects).toHaveLength(1)
  })

  it('部分失败的事务（executed>0）入栈：已生效部分可撤销', () => {
    const h = createHistory()
    const partial = executeWithHistory(h, [createCircle(), { op: 'delete', target: { byName: '不存在' } }])
    expect(partial.executed).toBe(1)
    expect(partial.error?.code).toBe('TARGET_NOT_FOUND')
    expect(partial.history.scene.objects).toHaveLength(1)
    const undone = executeWithHistory(partial.history, [{ op: 'undo' }])
    expect(undone.history.scene.objects).toHaveLength(0)
  })

  it('栈深上限 50，超出丢最旧', () => {
    let h = createHistory()
    for (let i = 0; i < MAX_UNDO_DEPTH + 5; i++) {
      h = executeWithHistory(h, [createCircle()]).history
    }
    expect(h.undoStack).toHaveLength(MAX_UNDO_DEPTH)
    // 撤到栈底：只能回到第 5 个事务之后的状态（前 5 帧已被丢弃）
    const r = executeWithHistory(h, [{ op: 'undo', steps: 999 }])
    expect(r.steps).toBe(MAX_UNDO_DEPTH)
    expect(r.history.scene.objects).toHaveLength(5)
  })
})

describe('clear 可撤销（规格 §5.4）', () => {
  it('clear 清空画布与焦点，undo 整体恢复', () => {
    const h = runAll([[createCircle('太阳')], [{ op: 'create', shape: 'rect' }]])
    const cleared = executeWithHistory(h, [{ op: 'clear' }])
    expect(cleared.error).toBeUndefined()
    expect(cleared.history.scene.objects).toHaveLength(0)
    expect(cleared.history.scene.focusId).toBeUndefined()
    const restored = executeWithHistory(cleared.history, [{ op: 'undo' }])
    expect(restored.history.scene.objects).toHaveLength(2)
    expect(restored.history.scene.objects[0].name).toBe('太阳')
  })

  it('clear 不重置 id 计数（id 全程不复用）', () => {
    const h = runAll([[createCircle()], [{ op: 'clear' }], [createCircle()]])
    expect(h.scene.objects[0].id).toBe('circle#2')
  })
})

describe('llm-plan 自动编组（§5.1，executeWithHistory autoGroupName）', () => {
  it('事务新建对象 ≥2 → 编为一组；一次 undo 整体回退（含编组）', () => {
    let h = createHistory()
    const r = executeWithHistory(
      h,
      [
        { op: 'create', shape: 'circle', name: '雪人身体', at: { x: 500, y: 500 }, size: 100 },
        { op: 'create', shape: 'circle', name: '雪人头', at: { x: 500, y: 330 }, size: 60 },
      ],
      { autoGroupName: '雪人' },
    )
    expect(r.error).toBeUndefined()
    expect(r.history.scene.objects.every((o) => o.groupId === '雪人')).toBe(true)
    expect(r.history.scene.focusId).toBe('circle#2')
    h = r.history
    const undone = executeWithHistory(h, [{ op: 'undo' }])
    expect(undone.history.scene.objects).toHaveLength(0)
  })

  it('只新建 1 个对象不编组；组名占用自动加序号', () => {
    const one = executeWithHistory(createHistory(), [{ op: 'create', shape: 'circle' }], { autoGroupName: '雪人' })
    expect(one.history.scene.objects[0].groupId).toBeUndefined()

    let h = createHistory()
    h = executeWithHistory(h, [
      { op: 'create', shape: 'rect', at: { x: 100, y: 100 } },
      { op: 'create', shape: 'rect', at: { x: 300, y: 100 } },
    ], { autoGroupName: '雪人' }).history
    const again = executeWithHistory(h, [
      { op: 'create', shape: 'circle', at: { x: 600, y: 300 } },
      { op: 'create', shape: 'circle', at: { x: 800, y: 300 } },
    ], { autoGroupName: '雪人' })
    const groups = new Set(again.history.scene.objects.map((o) => o.groupId))
    expect(groups.has('雪人')).toBe(true)
    expect(groups.has('雪人2')).toBe(true)
  })
})

describe('渐进事务提交 commitIncremental（协议 v1.4 流式绘制）', () => {
  it('流式逐 Op 推进后一次性入栈：undo 一步回退整幅；autoGroup 生效', () => {
    const base = createHistory()
    let scene = base.scene
    for (const op of [
      { op: 'create', shape: 'circle', name: '身体', at: { x: 500, y: 500 }, size: 100 },
      { op: 'create', shape: 'circle', name: '头', at: { x: 500, y: 330 }, size: 60 },
    ] as const) {
      const r = executeTransaction(scene, [op as Op])
      expect(r.error).toBeUndefined()
      scene = r.state
    }
    const h = commitIncremental(base, scene, { autoGroupName: '雪人' })
    expect(h.scene.objects).toHaveLength(2)
    expect(h.scene.objects.every((o) => o.groupId === '雪人')).toBe(true)
    expect(h.undoStack).toHaveLength(1)
    const undone = executeWithHistory(h, [{ op: 'undo' }])
    expect(undone.history.scene.objects).toHaveLength(0)
  })

  it('场景未变（流式零产出）不产生快照', () => {
    const base = createHistory()
    expect(commitIncremental(base, base.scene)).toBe(base)
  })
})
