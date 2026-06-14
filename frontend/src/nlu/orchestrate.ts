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
import { type SceneState, getBBox } from '../engine/scene'
import type { Op } from '../dsl'
import { type LlmCallContext, parseWithLlmStream } from './llm'
import { planLayout } from './planner'

/**
 * 把 SVG path data（M/L/C/Q/Z 绝对坐标，全是 x,y 数对，Z 无数字）按仿射变换：
 *   新坐标 = scale * (旧坐标 - 轴心) + 目标中心
 * 偶数下标（0,2,4,…）= x，奇数下标（1,3,5,…）= y。
 * 假定 d 只含 M/L/C/Q/Z（prompt 已约束），若含 A 弧等奇数参数命令此算法坐标对应会偏移，
 * 届时需按命令逐参数处理；目前 vpath 子计划 prompt 不允许 A，故安全。
 */
function affinePathD(
  d: string,
  scale: number,
  bcx: number,
  bcy: number,
  tcx: number,
  tcy: number,
): string {
  let i = -1
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    i++
    const v = parseFloat(n)
    const out = i % 2 === 0 ? scale * (v - bcx) + tcx : scale * (v - bcy) + tcy
    return String(Math.round(out * 10) / 10)
  })
}

/**
 * 把 groupId===label 的整组对象等比仿射缩放+平移，使整组包围盒贴合目标框 box（不溢出）。
 * vpath 走 d 字串仿射（主路径）；非 vpath 图元至少平移到框内中心。
 */
function fitGroupToBox(
  s: SceneState,
  label: string,
  box: { cx: number; cy: number; w: number; h: number },
): SceneState {
  const members = s.objects.filter((o) => o.groupId === label)
  if (members.length === 0) return s

  // 整组并集包围盒
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const o of members) {
    const [bx, by, bw, bh] = getBBox(o)
    minX = Math.min(minX, bx)
    minY = Math.min(minY, by)
    maxX = Math.max(maxX, bx + bw)
    maxY = Math.max(maxY, by + bh)
  }

  const gw = Math.max(1, maxX - minX)
  const gh = Math.max(1, maxY - minY)
  const bcx = (minX + maxX) / 2
  const bcy = (minY + maxY) / 2
  // 等比贴合（哪边先碰到框就停，保证不溢出）
  const scale = Math.min(box.w / gw, box.h / gh)

  const ids = new Set(members.map((o) => o.id))
  const objects = s.objects.map((o) => {
    if (!ids.has(o.id)) return o
    if (o.d !== undefined) {
      // vpath：d 直接仿射（x,y 平移视为 0，子计划 vpath 通常 x=0,y=0；保险起见并入计算）
      const nd = affinePathD(o.d, scale, bcx, bcy, box.cx, box.cy)
      return { ...o, d: nd, x: 0, y: 0 }
    }
    // 非 vpath 图元：中心按同样仿射平移，尺寸等比缩
    const [ox, oy, ow, oh] = getBBox(o)
    const ocx = ox + ow / 2
    const ocy = oy + oh / 2
    const ncx = scale * (ocx - bcx) + box.cx
    const ncy = scale * (ocy - bcy) + box.cy
    const cur = { x: o.x ?? 0, y: o.y ?? 0 }
    return {
      ...o,
      x: cur.x + (ncx - ocx),
      y: cur.y + (ncy - ocy),
      ...(o.radius !== undefined ? { radius: o.radius * scale } : {}),
      ...(o.radiusX !== undefined ? { radiusX: o.radiusX * scale } : {}),
      ...(o.radiusY !== undefined ? { radiusY: o.radiusY * scale } : {}),
      ...(o.width !== undefined ? { width: o.width * scale } : {}),
      ...(o.height !== undefined ? { height: o.height * scale } : {}),
    }
  })
  return { ...s, objects }
}

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

  // 内部 draw 函数（串行调用，共享闭包 scene）
  // 角色在画布中心放开画大（prompt 不约束位置/尺寸），finish 后 fitGroupToBox 缩放平移到目标框，
  // 最后一次性 onScene（避免"画中心闪一下又飞到角落"的视觉抖动）。
  const draw = async (
    prompt: string,
    label: string,
    box: { cx: number; cy: number; w: number; h: number },
  ): Promise<void> => {
    const before = scene
    const runner = createForwardTolerantRunner(scene, (op: Op, state: SceneState) => {
      painted++
      scene = state
      // 不在此 onScene：角色在画布中心隐形画好，fit 到框后再一次性渲染
      if (op.op === 'create' && op.desc !== undefined) cb.onLog(`▸ ${op.desc}`)
    })
    try {
      await parseWithLlmStream(prompt, 'plan', { ...ctx, scene: before }, (op) => runner.push(op))
    } catch (e) {
      cb.onLog(`「${label}」流式异常，保留已画部分`)
    }
    scene = runner.finish().state
    if (scene === before) { cb.onLog(`「${label}」未画成，跳过`); return }
    scene = applyAutoGroup(before, scene, label)
    scene = fitGroupToBox(scene, label, box)   // 等比仿射缩放平移到目标框（不溢出）
    if (!firstPaint) { firstPaint = true; cb.onFirstPaint?.() }
    cb.onScene(scene)                           // 一次性渲染（已贴好框）
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
      `整体画大、居中于画布中心 (512,384)、充分施展细节（不用管它最终摆在哪、多大，我会自动缩放摆放到画面里）` +
      (style !== undefined ? `，画风：${style}` : '') +
      `。只画${s.label}这一个主体，不画背景或其它角色。`
    await draw(prompt, s.label, { cx: s.cx, cy: s.cy, w: s.w, h: s.h })
  }

  // Step 4: 全部失败时回退
  if (painted === 0) {
    cb.onLog('一件都没画成→退回普通 plan')
    return { ok: false, fallback: true }
  }

  return { ok: true, scene, subjectCount: subjects.length }
}
