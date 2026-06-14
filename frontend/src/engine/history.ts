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
import { createEmptyScene, isBackgroundObject } from './scene'

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

/**
 * llm-plan 自动编组（§5.1）：base 之后新建的对象（createdSeq > base.seq）编为一组。
 *
 * 背景层隔离（修复"整组 move 纹丝不动"根因）：
 * - 背景对象（isBackgroundObject 为真）统一打 background:true 标记；
 * - 背景对象不纳入主体组（groupId 不被覆写为主体名）；
 *   若场景里本次只有背景对象（如 orchestrate.ts 专门调用 applyAutoGroup(·,·,'背景')），
 *   则按正常逻辑给背景对象赋 groupId（保持多主体路径原有行为不变）；
 * - 主体组门槛按**非背景对象数**判定（< 2 时不编组）；
 * - 即使非背景对象不足 2 个不编组，背景对象仍打 background:true 标记。
 * - 双保险：interpreter.ts 的 membersOf 也通过 !o.background 过滤，
 *   即使背景万一带了 groupId，几何操作也不会波及它。
 */
export function applyAutoGroup(base: SceneState, scene: SceneState, autoGroupName: string): SceneState {
  const created = scene.objects.filter((o) => o.createdSeq > base.seq)
  // 区分背景对象与主体部件
  const bgObjects = created.filter(isBackgroundObject)
  const subjectParts = created.filter((o) => !isBackgroundObject(o))

  // 是否有主体部件（非背景）
  const hasSubjects = subjectParts.length > 0
  // 是否有足够主体部件编组
  const canGroup = subjectParts.length >= 2

  // 若本次新建全是背景对象（无主体部件），按原始逻辑全部编为 autoGroupName 组（如 orchestrate.ts 画背景时）
  if (!hasSubjects) {
    if (bgObjects.length === 0) return scene
    // 全背景路径：打 background 标记 + 正常编组（保留原行为，如 groupId='背景'）
    const taken = new Set<string>(
      scene.objects.flatMap((o) => [o.groupId, o.name]).filter((x): x is string => x !== undefined),
    )
    let groupName = autoGroupName
    for (let i = 2; bgObjects.length >= 2 && taken.has(groupName); i++) groupName = `${autoGroupName}${i}`
    const bgIds = new Set(bgObjects.map((o) => o.id))
    return {
      ...scene,
      objects: scene.objects.map((o) =>
        bgIds.has(o.id)
          ? { ...o, background: true, groupId: bgObjects.length >= 2 ? groupName : undefined }
          : o,
      ),
      // 背景独立帧不切换焦点粒度
      focusScope: scene.focusScope,
    }
  }

  // 混合路径（主体 + 可能有背景）：背景打标但不纳入主体组
  const bgIds = new Set(bgObjects.map((o) => o.id))

  // 生成不冲突的主体组名（只在 canGroup 时有意义）
  let groupName = autoGroupName
  if (canGroup) {
    const taken = new Set<string>(
      scene.objects.flatMap((o) => [o.groupId, o.name]).filter((x): x is string => x !== undefined),
    )
    for (let i = 2; taken.has(groupName); i++) groupName = `${autoGroupName}${i}`
  }

  const subjectIds = new Set(subjectParts.map((o) => o.id))

  // 刚画完整组 → 焦点粒度=组（"它"=整只猫；§5.1 v1.1）
  return {
    ...scene,
    objects: scene.objects.map((o) => {
      if (bgIds.has(o.id)) {
        // 背景对象：打标记，不覆写 groupId（背景不属于主体组）
        return { ...o, background: true }
      }
      if (canGroup && subjectIds.has(o.id)) {
        // 主体部件：编入主体组
        return { ...o, groupId: groupName }
      }
      return o
    }),
    // 有主体编组才切换焦点粒度，否则保持原状
    focusScope: canGroup ? 'group' : scene.focusScope,
  }
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
