/**
 * 事务式 undo/redo —— 快照栈（规格 §5.4）
 *
 * 不做逆操作：每个产生变更的事务提交后，把提交前的场景整帧压入 undo 栈。
 * 解释器是纯函数（历史帧天然不可变），快照只是引用共享，无需深拷贝/序列化。
 *
 * 语义要点：
 * - 栈深 50，超出丢最旧；redo 栈在新事务提交时清空
 * - undo steps:n 弹 n 帧，n 超过可用深度撤到栈底为止；栈空才报 NOTHING_TO_UNDO
 * - 快照含焦点 id（undo 后焦点一并恢复，§5.1）
 * - 事务部分失败（executed > 0）同样入栈：已生效的部分必须可撤销
 * - undo/redo 必须单独成事务（协议 §1.5），与其他 Op 混合报 INVALID_OP
 */
import type { Op } from '../dsl'
import type { EngineError, ExecOutcome } from './interpreter'
import { executeTransaction } from './interpreter'
import type { SceneState } from './scene'
import { createEmptyScene } from './scene'

export const MAX_UNDO_DEPTH = 50

export interface HistoryState {
  scene: SceneState
  undoStack: SceneState[]
  redoStack: SceneState[]
}

export function createHistory(scene?: SceneState): HistoryState {
  return { scene: scene ?? createEmptyScene(), undoStack: [], redoStack: [] }
}

export interface HistoryOutcome extends ExecOutcome {
  history: HistoryState
  /** undo/redo 实际回退/重做的帧数 */
  steps?: number
}

const err = (code: EngineError['code'], message: string): EngineError => ({ code, message })

export function executeWithHistory(h: HistoryState, ops: Op[]): HistoryOutcome {
  const hasHistoryOp = ops.some((op) => op.op === 'undo' || op.op === 'redo')

  if (hasHistoryOp) {
    if (ops.length > 1) {
      return {
        history: h,
        state: h.scene,
        executed: 0,
        error: err('INVALID_OP', 'undo/redo 必须作为单独指令执行'),
      }
    }
    const op = ops[0] as Extract<Op, { op: 'undo' | 'redo' }>
    const want = op.steps ?? 1

    if (op.op === 'undo') {
      if (h.undoStack.length === 0) {
        return { history: h, state: h.scene, executed: 0, error: err('NOTHING_TO_UNDO', '已经没有可以撤销的操作了') }
      }
      const n = Math.min(want, h.undoStack.length)
      const undoStack = [...h.undoStack]
      const redoStack = [...h.redoStack]
      let scene = h.scene
      for (let i = 0; i < n; i++) {
        redoStack.push(scene)
        scene = undoStack.pop()!
      }
      return { history: { scene, undoStack, redoStack }, state: scene, executed: 1, steps: n }
    }

    // redo
    if (h.redoStack.length === 0) {
      return { history: h, state: h.scene, executed: 0, error: err('NOTHING_TO_REDO', '没有可以重做的操作') }
    }
    const n = Math.min(want, h.redoStack.length)
    const undoStack = [...h.undoStack]
    const redoStack = [...h.redoStack]
    let scene = h.scene
    for (let i = 0; i < n; i++) {
      undoStack.push(scene)
      scene = redoStack.pop()!
    }
    return { history: { scene, undoStack, redoStack }, state: scene, executed: 1, steps: n }
  }

  // 普通（变更类）事务
  const r = executeTransaction(h.scene, ops)
  if (r.executed === 0) {
    // 无任何生效 Op：不产生快照，redo 栈保留
    return { history: h, ...r }
  }
  const undoStack = [...h.undoStack, h.scene]
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift()
  return { history: { scene: r.state, undoStack, redoStack: [] }, ...r }
}
