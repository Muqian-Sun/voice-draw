/**
 * 多主体 plan 编排器（按角色拆子计划设计 Phase 1 PR-2）
 *
 * orchestrateSubplans：
 *   多主体话术 → planLayout 布局 → 框去重叠 → 背景（planLayout 后画，z 垫底）→
 *   并发触发所有角色 LLM 调用（非流式，按框面积给笔数预算）→
 *   串行按序应用（执行 + 编组 + fit）→ 首帧背景+首主体同时出 → 返回最终场景。
 *
 * 单主体 / planner 失败 / 全部失败 → ok:false fallback，调用方继续走普通流式 plan。
 *
 * 性能优化：串行 N×~37s ≈ 数分钟 → 并发取 LLM（非流式）串行应用 ≈ 单次 ~40s；
 *   ID 生成走串行 apply，不冲突。
 * 背景 z 垫底：背景在 baseScene 之上创建（maxZ+1/+2），后续主体对象从更高 z 开始，天然在背景之上。
 */
import { applyAutoGroup } from '../engine/history'
import { executeTransaction } from '../engine/interpreter'
import { type SceneState, getBBox } from '../engine/scene'
import type { Op } from '../dsl'
import { type LlmCallContext, parseWithLlm } from './llm'
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

/** 计算 groupId===label 所有成员的并集包围盒 */
function groupBBox(s: SceneState, label: string): { w: number; h: number } {
  const members = s.objects.filter((o) => o.groupId === label)
  if (members.length === 0) return { w: 0, h: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const o of members) {
    const [bx, by, bw, bh] = getBBox(o)
    minX = Math.min(minX, bx); minY = Math.min(minY, by)
    maxX = Math.max(maxX, bx + bw); maxY = Math.max(maxY, by + bh)
  }
  return { w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) }
}

/**
 * 推开相互重叠的布局框（AABB 碰撞 + 迭代松弛）。
 * 治"七个小矮人叠在一堆"问题：planLayout 给框后做几何后处理，
 * 无需二次 LLM 调用。
 */
function deoverlapBoxes(
  subjects: Array<{ cx: number; cy: number; w: number; h: number }>,
  W = 1024,
  H = 768,
): void {
  for (let iter = 0; iter < 30; iter++) {
    let moved = false
    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const a = subjects[i], b = subjects[j]
        const ox = (a.w + b.w) / 2 - Math.abs(a.cx - b.cx)
        const oy = (a.h + b.h) / 2 - Math.abs(a.cy - b.cy)
        if (ox > 0 && oy > 0) {
          moved = true
          if (ox <= oy) {
            const push = ox / 2 + 1
            const dir = a.cx <= b.cx ? -1 : 1
            a.cx += dir * push; b.cx -= dir * push
          } else {
            const push = oy / 2 + 1
            const dir = a.cy <= b.cy ? -1 : 1
            a.cy += dir * push; b.cy -= dir * push
          }
        }
      }
    }
    if (!moved) break
  }
  // 夹回画布范围
  for (const s of subjects) {
    s.cx = Math.min(Math.max(s.cx, s.w / 2), W - s.w / 2)
    s.cy = Math.min(Math.max(s.cy, s.h / 2), H - s.h / 2)
  }
}

export async function orchestrateSubplans(
  utterance: string,
  baseScene: SceneState,
  ctx: LlmCallContext,
  cb: OrchestrateCallbacks,
): Promise<OrchestrateResult> {
  // 闭包状态
  let scene = baseScene
  let painted = 0
  let firstPaint = false

  // Step 1: 布局规划（先等规划结果，背景跟首个主体一起出，不单独出现空背景帧）
  cb.onLog('正在规划构图…')
  const lay = await planLayout(utterance, { ...ctx, scene: baseScene })
  if (!lay.ok || lay.layout.subjects.length <= 1) {
    cb.onLog(lay.ok ? '布局主体数 ≤1 → 退回普通 plan' : `planLayout 失败：${lay.error}`)
    return { ok: false, fallback: true }
  }

  // subjects 是 zod .parse 生成的普通对象（非 frozen），可直接修改
  const { style, subjects } = lay.layout
  cb.onLog(`布局：${subjects.length} 个主体，去重叠后并行请求 LLM…`)

  // Step 2: 框去重叠（AABB 迭代推开，治多矮人重叠）
  deoverlapBoxes(subjects)

  // Step 3: 背景在 planLayout 之后画（z 垫底）。
  // 背景先于所有主体创建→背景对象 z = baseScene.maxZ+{1,2}；
  // 后续主体对象 z 从 maxZ+3 开始递增，天然高于背景——无需手动调 z。
  // 不单独 onScene/onFirstPaint：用户看不到"只有背景的空帧"，
  // 首帧渲染在第一个主体应用完后触发（背景+主体同时出现）。
  const bgOps = backgroundOps(utterance)
  if (bgOps.length > 0) {
    const before = scene
    const ex = executeTransaction(scene, bgOps)
    if (ex.state !== before) {
      scene = applyAutoGroup(before, ex.state, '背景')
      cb.onLog('▸ 背景已铺（天空/地面），等首个主体一起出图…')
      // 注意：此处不调 onScene / onFirstPaint，背景不独立出帧
    }
  }

  // Step 4: 并发触发所有角色的 LLM 调用（非流式 parseWithLlm）
  // 以 planLayout + 背景应用后的 scene 为共享上下文基线；所有角色同时请求，
  // LLM 耗时从 N×串行 变成 max(各角色) 并行。
  const bgScene = scene  // 背景已应用后的基准，供所有子计划共享读取
  const pending = subjects.map(async (s) => {
    // 按目标框面积给笔数预算：小框（矮人等）少画快出，大框（主角）多画精细。
    // 线性映射：budget = clamp(round(w*h / 4000), 10, 22)
    // 约 200×200=40000 → 10笔；约 300×300=90000 → 22笔（取上限）。
    const budget = Math.max(10, Math.min(22, Math.round(s.w * s.h / 4000)))

    // 子计划话术：只给编排框架（单主体、画大、画全、居中供缩放贴框）；
    // 外观/结构/比例/部件细节全交给 SYSTEM_PROMPT + LLM 自身知识，不在此写死。
    const prompt =
      `只画「${s.label}」这一个主体，不要画背景、地面或其它角色。` +
      `把 ${s.label} 的所有部件画完整、细节到位，别省略或截断成残缺轮廓；` +
      `整体画大、居中于画布中心 (512,384)（不用管它最终摆在哪、多大，我会自动缩放摆放进画面）` +
      (style !== undefined ? `，画风：${style}` : '') +
      `。用约 ${budget} 个部件画到位、抓住${s.label}的特征即可、不要堆冗余细节（画得越精简越快，但部件要完整）。`
    try {
      const res = await parseWithLlm(prompt, 'plan', { ...ctx, scene: bgScene })
      return { s, ops: res.ok ? res.result.ops : [] as Op[] }
    } catch {
      return { s, ops: [] as Op[] }
    }
  })

  // Step 5: 串行按序应用（保证 ID 自增不冲突，渐进 onScene）
  for (const p of pending) {
    const { s, ops } = await p
    if (ops.length === 0) {
      cb.onLog(`「${s.label}」未画成，跳过`)
      continue
    }
    const before = scene
    const ex = executeTransaction(scene, ops)
    if (ex.state === before) {
      cb.onLog(`「${s.label}」未画成，跳过`)
      continue
    }
    let s2 = applyAutoGroup(before, ex.state, s.label)

    // fit 前后记录 bbox 日志（诊断"矮人偏大/框太小"等问题）
    const pre = groupBBox(s2, s.label)
    s2 = fitGroupToBox(s2, s.label, { cx: s.cx, cy: s.cy, w: s.w, h: s.h })
    const post = groupBBox(s2, s.label)
    const overflow = post.w > s.w + 8 || post.h > s.h + 8
    const budget = Math.max(10, Math.min(22, Math.round(s.w * s.h / 4000)))
    cb.onLog(
      `▸ ${s.label}: 画${ops.length}笔(预算${budget}) 框${Math.round(s.w)}×${Math.round(s.h)}` +
      ` → 原bbox ${Math.round(pre.w)}×${Math.round(pre.h)}` +
      ` → 贴框后 ${Math.round(post.w)}×${Math.round(post.h)}` +
      (overflow ? ' ⚠超框' : ''),
    )

    scene = s2
    painted++
    if (!firstPaint) { firstPaint = true; cb.onFirstPaint?.() }
    cb.onScene(scene)
  }

  // Step 6: 全部失败时回退
  if (painted === 0) {
    cb.onLog('一件都没画成→退回普通 plan')
    return { ok: false, fallback: true }
  }

  return { ok: true, scene, subjectCount: subjects.length }
}
