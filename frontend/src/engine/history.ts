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

export interface ExecuteOptions {
  /**
   * llm-plan 来源事务的自动编组（§5.1）：事务成功后把本事务全部新建对象编为一组，
   * 组名 = 用户话术主名词（路由器提取），焦点保持最后一个 create 的成员。
   * 编组与绘制同属一个快照（一次 undo 整体回退）。
   */
  autoGroupName?: string
}

export function executeWithHistory(h: HistoryState, ops: Op[], opts: ExecuteOptions = {}): HistoryOutcome {
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
  if (r.executed === 0 || r.state === h.scene) {
    // 无任何生效 Op / 状态未变（如纯 export 事务）：不产生快照，redo 栈保留
    return { history: h, ...r }
  }

  let scene = r.state
  if (opts.autoGroupName !== undefined && r.error === undefined) {
    scene = applyAutoGroup(h.scene, scene, opts.autoGroupName)
  }

  const undoStack = [...h.undoStack, h.scene]
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift()
  return { history: { scene, undoStack, redoStack: [] }, ...r, state: scene }
}

/** llm-plan 自动编组（§5.1）：base 之后新建的对象（createdSeq > base.seq）编为一组 */
function applyAutoGroup(base: SceneState, scene: SceneState, autoGroupName: string): SceneState {
  const created = scene.objects.filter((o) => o.createdSeq > base.seq)
  if (created.length < 2) return scene
  const taken = new Set<string>(
    scene.objects.flatMap((o) => [o.groupId, o.name]).filter((x): x is string => x !== undefined),
  )
  let name = autoGroupName
  for (let i = 2; taken.has(name); i++) name = `${autoGroupName}${i}`
  const ids = new Set(created.map((o) => o.id))
  return { ...scene, objects: scene.objects.map((o) => (ids.has(o.id) ? { ...o, groupId: name } : o)) }
}

/**
 * 渐进事务提交（协议 v1.4 流式绘制）：流式期间调用方用 executeTransaction 逐 Op
 * 推进可见场景（不入栈），流结束后由本函数把"事务前基线"一次性压栈——
 * undo 语义与缓冲模式完全一致（一次回退整幅）。finalScene 与基线相同则不产生快照。
 */
export function commitIncremental(base: HistoryState, finalScene: SceneState, opts: ExecuteOptions = {}): HistoryState {
  if (finalScene === base.scene) return base
  const scene = opts.autoGroupName !== undefined ? applyAutoGroup(base.scene, finalScene, opts.autoGroupName) : finalScene
  const undoStack = [...base.undoStack, base.scene]
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift()
  return { scene, undoStack, redoStack: [] }
}
