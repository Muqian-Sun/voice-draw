/**
 * 流式渐进绘制 · 容错执行（修复"画一半画布清空、过一会完整重贴"）
 * =====================================================================
 * 背景：plan 流式时逐 op 到达即用 executeTransaction 单 op 推进可见场景（渐进出图）。
 * 旧逻辑里**任何单 op 执行失败都会整幅中止 → setHistory(base) 回滚清空 → 再发第二次
 * 完整 LLM 调用兜底贴出**（用户可见"画一半 → 清空 → 过一会完整贴出"）。两类失败常见：
 *
 *  1) 前向引用（TARGET_NOT_FOUND）：LLM 不保证严格"先创建后引用"，某个
 *     at.ref/mirror.about/连线/相对尺寸/zorder 在它引用的对象之前到达；
 *  2) 同名歧义（AMBIGUOUS_TARGET）：画布已有同名对象时（v2.0 场景持久化：画完一幅、
 *     刷新后再画新主体，新主体部件名"左眼/身体"与旧的撞车），plan 末尾的 group 等
 *     非 preferRecent 引用按名解析命中多个 → 歧义。
 *
 * 本 runner 让流式执行容错、**绝不因单 op 失败清空整幅**：
 *  - TARGET_NOT_FOUND 的 op 暂存（pending），每成功应用一个 op 就重试暂存队列
 *    （链式依赖逐层解锁）；流毕仍悬空的留 pending（真·悬空引用，仅记日志、不清空）。
 *  - 其它错误（AMBIGUOUS_TARGET / INVALID_OP 等）的 op 软跳过（skipped），保留已画部分、
 *    继续后续 op；plan 的显式 group 即便被跳过也无妨——commit 时 autoGroup 仍会编组。
 *
 * 上层据此**总是提交已成功绘制的部分**（painted>0 即提交），不再回滚 + 二次 LLM 调用。
 */
import type { Op } from '../dsl'
import { executeTransaction, type EngineError } from './interpreter'
import type { SceneState } from './scene'

export interface ForwardTolerantResult {
  /** 最终累积场景（已应用全部可解析 op） */
  state: SceneState
  /** 流毕仍无法解析（依赖始终未创建）的 op，非空即"真·悬空引用" */
  pending: Op[]
  /** 因非前向引用错误（歧义/非法等）被软跳过的 op 及其错误（仅记录，不影响其余绘制） */
  skipped: Array<{ op: Op; error: EngineError }>
}

export interface ForwardTolerantRunner {
  /** 流式到达一个 op：可应用即应用（并触发暂存重试）；前向引用暂存；其它错误软跳过 */
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
  const skipped: Array<{ op: Op; error: EngineError }> = []

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
    while (progressed && pending.length > 0) {
      progressed = false
      for (let i = 0; i < pending.length; ) {
        const e = apply1(pending[i])
        if (e === undefined) {
          pending.splice(i, 1)
          progressed = true
        } else if (e.code === 'TARGET_NOT_FOUND') {
          i++ // 依赖仍未创建，继续暂存
        } else {
          // 依赖已就位但另有错误（歧义等）→ 软跳过，不卡住队列、不清空整幅
          skipped.push({ op: pending[i], error: e })
          pending.splice(i, 1)
          progressed = true
        }
      }
    }
  }

  return {
    push(op) {
      const e = apply1(op)
      if (e === undefined) {
        flush() // 新对象可能解锁此前暂存的前向引用
      } else if (e.code === 'TARGET_NOT_FOUND') {
        pending.push(op) // 疑似前向引用：暂存待依赖创建
      } else {
        skipped.push({ op, error: e }) // 歧义/非法等：软跳过，保留已画部分继续
      }
    },
    finish() {
      flush()
      return { state, pending: [...pending], skipped: [...skipped] }
    },
  }
}
