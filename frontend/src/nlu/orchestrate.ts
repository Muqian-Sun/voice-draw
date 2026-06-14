/**
 * 多主体 plan 编排器（按角色拆子计划设计 Phase 1 PR-2）
 *
 * orchestrateSubplans：
 *   多主体话术 → planLayout 布局 → 背景 + 逐角色子计划（各自 parseWithLlmStream plan 模式 +
 *   forwardRetry runner 逐 op 渐进应用） → 逐角色 applyAutoGroup 编组 → 返回最终场景。
 *
 * 单主体 / planner 失败 / 全部失败 → ok:false fallback，调用方继续走普通流式 plan。
 */
import { applyAutoGroup } from '../engine/history'
import { createForwardTolerantRunner } from '../engine/forwardRetry'
import type { SceneState } from '../engine/scene'
import type { Op } from '../dsl'
import { type LlmCallContext, parseWithLlmStream } from './llm'
import { planLayout } from './planner'

/**
 * 按描述关键词选天/地配色，返回 2 个铺满画布的渐变 rect create op。
 * 画布逻辑尺寸 1024x768；天空上半（y=0~460）中心 y=230，地面下半（y=460~768）中心 y=614。
 * 不走 LLM，瞬时直接应用，让首个角色紧跟 planner 就开始绘制。
 */
function backgroundOps(desc: string): Op[] {
  const d = desc || ''
  let sky: [string, string] = ['#CDEBFF', '#F7FCFF']
  let ground: [string, string] = ['#9BD46E', '#5BA83F']
  if (/海|水|湖|河|洋/.test(d)) ground = ['#5BB5E8', '#2A7FB8']
  else if (/夜|星|晚|月/.test(d)) { sky = ['#1B2A4A', '#3A4A6B']; ground = ['#243B55', '#1B2A4A'] }
  else if (/雪|冬|冰/.test(d)) ground = ['#EAF4FB', '#CFE3F0']
  else if (/沙漠|沙滩|沙/.test(d)) { sky = ['#FCE7B5', '#FFF6E0']; ground = ['#E8C07A', '#C99A4E'] }
  else if (/室内|房间|屋里|客厅|卧室/.test(d)) { sky = ['#F3E9D8', '#FBF6EC']; ground = ['#D8C3A0', '#B89B72'] }
  return [
    {
      op: 'create',
      shape: 'rect',
      name: '背景天空',
      gradient: { from: sky[0], to: sky[1], angle: 90 },
      at: { x: 512, y: 230 },
      width: 1024,
      height: 460,
      desc: '画背景天空',
    } as Op,
    {
      op: 'create',
      shape: 'rect',
      name: '背景地面',
      gradient: { from: ground[0], to: ground[1], angle: 90 },
      at: { x: 512, y: 614 },
      width: 1024,
      height: 308,
      desc: '画背景地面',
    } as Op,
  ]
}

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
  cb.onLog('正在规划构图…')
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

  // 内部 draw 函数（串行调用，共享闭包 scene）——流式：onOp 每到一个 op 就 push 进 runner（逐 op 渐进出图）
  const draw = async (prompt: string, label: string): Promise<void> => {
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
    try {
      // 流式：onOp 每到一个 op 就 push 进 runner（逐 op 渐进出图）。即便终验未过，已 push 的 op 也保留。
      await parseWithLlmStream(prompt, 'plan', { ...ctx, scene: before }, (op) => runner.push(op))
    } catch (e) {
      cb.onLog(`「${label}」流式异常，保留已画部分`)
    }
    scene = runner.finish().state
    if (scene === before) { cb.onLog(`「${label}」未画成，跳过`); return }
    scene = applyAutoGroup(before, scene, label)
    cb.onScene(scene)
  }

  // Step 2: 背景瞬时直接画（不走 LLM 子计划）：渐变天地铺满，让首个角色紧跟 planner 就开始
  if (background !== undefined) {
    const before = scene
    const runner = createForwardTolerantRunner(scene, (op: Op, state: SceneState) => {
      painted++
      if (!firstPaint) { firstPaint = true; cb.onFirstPaint?.() }
      scene = state
      cb.onScene(state)
      if (op.op === 'create' && op.desc !== undefined) cb.onLog(`▸ ${op.desc}`)
    })
    for (const op of backgroundOps(background)) runner.push(op)
    scene = runner.finish().state
    if (scene !== before) scene = applyAutoGroup(before, scene, '背景')
    cb.onScene(scene)
  }

  // Step 3: 逐角色串行绘制
  for (const s of subjects) {
    const prompt =
      `画一个完整、精致的${s.label}：五官清晰且绝不被头发/帽子遮挡（先画脸、头发只框住脸侧、五官放最上层 zorder）、` +
      `身体四肢俱全（含脚和鞋、手），细节到位、不要省略部件；` +
      `整体居中于画布坐标(${s.cx},${s.cy})、缩放到约 ${s.w}x${s.h} 的区域内` +
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
