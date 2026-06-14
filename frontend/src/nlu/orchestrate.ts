/**
 * 多主体 plan 编排器（按角色拆子计划设计 Phase 1 PR-2）
 *
 * orchestrateSubplans：
 *   多主体话术 → planLayout 布局 → 背景 + 逐角色子计划（各自 parseWithLlm plan 模式 +
 *   forwardRetry runner 渐进应用） → 逐角色 applyAutoGroup 编组 → 返回最终场景。
 *
 * 单主体 / planner 失败 / 全部失败 → ok:false fallback，调用方继续走普通流式 plan。
 */
import { applyAutoGroup } from '../engine/history'
import { createForwardTolerantRunner } from '../engine/forwardRetry'
import type { SceneState } from '../engine/scene'
import type { Op } from '../dsl'
import { type LlmCallContext, parseWithLlm } from './llm'
import { planLayout } from './planner'

export function looksMultiSubject(u: string): boolean {
  if (/[、和跟]|还有|以及|一家|一群|全家|多个|几个|一堆/.test(u)) return true
  if (/(两|三|四|五|六|七|八|九|十|[2-9])\s*(个|只|位|名|条|头|匹|朵|棵|架|辆)/.test(u)) return true
  return false
}

export interface OrchestrateCallbacks {
  /** 渐进渲染：场景每推进一步 */
  onScene: (scene: SceneState) => void
  /** 首次出图（切 FSM） */
  onFirstPaint?: () => void
  onLog: (msg: string) => void
}

export type OrchestrateResult =
  | { ok: true; scene: SceneState; subjectCount: number }
  | { ok: false; fallback: true }

export async function orchestrateSubplans(
  utterance: string,
  baseScene: SceneState,
  ctx: LlmCallContext,
  cb: OrchestrateCallbacks,
): Promise<OrchestrateResult> {
  // Step 1: 布局规划
  const lay = await planLayout(utterance, { ...ctx, scene: baseScene })
  if (!lay.ok || lay.layout.subjects.length <= 1) {
    cb.onLog(lay.ok ? '布局主体数 ≤1 → 退回普通 plan' : `planLayout 失败：${lay.error}`)
    return { ok: false, fallback: true }
  }

  const { background, style, subjects } = lay.layout
  cb.onLog(`布局：${subjects.length} 个主体，开始逐角色绘制…`)

  // 闭包状态
  let scene = baseScene
  let painted = 0
  let firstPaint = false

  // 内部 draw 函数（串行调用，共享闭包 scene）
  const draw = async (prompt: string, label: string): Promise<void> => {
    let llm: Awaited<ReturnType<typeof parseWithLlm>>
    try {
      llm = await parseWithLlm(prompt, 'plan', { ...ctx, scene })
    } catch (e) {
      cb.onLog(`「${label}」失败跳过`)
      return
    }
    if (!llm.ok || llm.result.intent !== 'ops' || llm.result.ops.length === 0) {
      cb.onLog(`「${label}」未画成，跳过`)
      return
    }
    const before = scene
    const runner = createForwardTolerantRunner(scene, (op: Op, state: SceneState) => {
      painted++
      if (!firstPaint) {
        firstPaint = true
        cb.onFirstPaint?.()
      }
      scene = state
      cb.onScene(state)
      if (op.op === 'create' && op.desc !== undefined) cb.onLog(`▸ ${op.desc}`)
    })
    for (const op of llm.result.ops) runner.push(op)
    scene = runner.finish().state
    scene = applyAutoGroup(before, scene, label)
    cb.onScene(scene)
  }

  // Step 2: 背景
  if (background !== undefined) {
    await draw(
      `画${background}作背景、用渐变铺满整个画布，不画任何主体`,
      background,
    )
  }

  // Step 3: 逐角色串行绘制
  for (const s of subjects) {
    const prompt =
      `画${s.label}，整体居中于画布坐标(${s.cx},${s.cy})、占据约 ${s.w}x${s.h} 的区域` +
      (style !== undefined ? `，画风：${style}` : '') +
      `。只画${s.label}这一个主体，不画背景或其它角色。`
    await draw(prompt, s.label)
  }

  // Step 4: 全部失败时回退
  if (painted === 0) {
    cb.onLog('一件都没画成→退回普通 plan')
    return { ok: false, fallback: true }
  }

  return { ok: true, scene, subjectCount: subjects.length }
}
