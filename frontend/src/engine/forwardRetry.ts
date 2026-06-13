/**
 * 流式渐进绘制 · 前向引用容忍执行（修复"画一半画布清空、过一会完整重贴"）
 * =====================================================================
 * 背景：plan 流式时逐 op 到达即用 executeTransaction 单 op 推进可见场景（渐进出图）。
 * 但 LLM 不保证严格"先创建后引用"——某个 create(at.ref/between)、mirror(about/target)、
 * 连接线(from/to)、相对尺寸(relativeTo)、zorder(above/below) 可能在它引用的对象之前到达。
 * 单 op 执行此时报 TARGET_NOT_FOUND。旧逻辑把它当致命错误：整幅渐进中止 → setHistory(base)
 * 回滚清空 → 再发第二次完整 LLM 调用兜底（用户可见"画一半 → 清空 → 过一会完整贴出"）。
 *
 * 本 runner 让乱序可恢复：TARGET_NOT_FOUND 的 op 暂存，每成功应用一个 op 就重试暂存队列
 * （一个新对象可能解锁链式暂存）；其它错误码（INVALID_OP / 越界等）视为硬失败立即停，
 * 交上层回退。流毕仍悬空的 op 留在 pending（真·悬空引用），同样由上层决定回退。
 *
 * 与缓冲路径的关系：executeTransaction 严格顺序、首错即停，不容忍批内前向引用；
 * 缓冲兜底之所以常能成功，是因为它重发了一次 LLM（通常这次顺序对了），而非引擎容错。
 * 本 runner 把容错下沉到流式执行本身，消除常见乱序触发的清空 + 二次调用。
 */
import type { Op } from '../dsl'
import { executeTransaction, type EngineError } from './interpreter'
import type { SceneState } from './scene'

export interface ForwardTolerantResult {
  /** 最终累积场景（已应用全部可解析 op） */
  state: SceneState
  /** 流毕仍无法解析（依赖始终未创建）的 op，非空即"真·悬空引用" */
  pending: Op[]
  /** 首个非 TARGET_NOT_FOUND 的硬错误（出现即停止后续）；undefined 表示无硬错误 */
  hardError?: EngineError
}

export interface ForwardTolerantRunner {
  /** 流式到达一个 op：可应用即应用（并触发暂存重试）；TARGET_NOT_FOUND 暂存；其它错误硬停 */
  push: (op: Op) => void
  /** 流结束：对暂存队列做最后一轮重试，返回最终态 */
  finish: () => ForwardTolerantResult
}

/**
 * @param initial   基线场景
 * @param onApply   每个 op 成功应用后回调（携带应用后的最新场景）——
 *                  用于渐进 setHistory / 进度日志 / 首件切状态机等副作用
 */
export function createForwardTolerantRunner(
  initial: SceneState,
  onApply?: (op: Op, state: SceneState) => void,
): ForwardTolerantRunner {
  let state = initial
  const pending: Op[] = []
  let hardError: EngineError | undefined

  // 试应用单个 op：成功则推进 state + 回调并返回 undefined；失败返回错误（不改 state）
  const apply1 = (op: Op): EngineError | undefined => {
    const r = executeTransaction(state, [op])
    if (r.error !== undefined) return r.error
    state = r.state
    onApply?.(op, state)
    return undefined
  }

  // 重试暂存队列直到无新进展（链式依赖：A 创建后解锁 B，B 再解锁 C）
  const flush = (): void => {
    let progressed = true
    while (progressed && pending.length > 0 && hardError === undefined) {
      progressed = false
      for (let i = 0; i < pending.length && hardError === undefined; ) {
        const e = apply1(pending[i])
        if (e === undefined) {
          pending.splice(i, 1)
          progressed = true
        } else if (e.code === 'TARGET_NOT_FOUND') {
          i++ // 依赖仍未创建，继续暂存
        } else {
          hardError = e // 依赖已就位但另有硬错误 → 浮出，停止
          pending.splice(i, 1)
        }
      }
    }
  }

  return {
    push(op) {
      if (hardError !== undefined) return // 已硬失败：忽略后续（上层将回退）
      const e = apply1(op)
      if (e === undefined) {
        flush() // 新对象可能解锁此前暂存的前向引用
      } else if (e.code === 'TARGET_NOT_FOUND') {
        pending.push(op) // 疑似前向引用：暂存待依赖创建
      } else {
        hardError = e // 其它错误：硬失败，交上层回退
      }
    },
    finish() {
      if (hardError === undefined) flush()
      return { state, pending: [...pending], hardError }
    },
  }
}
