import { describe, expect, it } from 'vitest'
import type { Op } from '../dsl'
import { createHistory, executeWithHistory, MAX_UNDO_DEPTH, type HistoryState } from './history'

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
