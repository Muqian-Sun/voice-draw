/**
 * 自由画笔主渲染器（feat/freehand-pen-direction-row-fill）
 * =====================================================
 * 把主应用的场景图（SceneState）用「会动的笔」逐笔手绘出来，整体替换 Konva 组件渲染。
 *
 * 关键：**增量、非整幅重画**（多轮编辑可用）——
 *  - 新增对象 → 入队，笔逐笔画出 → 落定烘焙进离屏 committed 画布；
 *  - 删除对象 → 从 committed 抹除（橡皮擦：重建 committed 时不再画它）；
 *  - 改动对象（移动/缩放/改色/旋转，签名变化）→ 抹旧 + 在新状态重新画一遍；
 *  - 未变对象 → 瞬时静态重绘进 committed（不重放动画），只有 delta 才走逐笔动画。
 *
 * 几何拆解复用 fromScene.objectToStrokes（组件引擎产出 SceneObject → 笔触，纯函数）；
 * 运笔/填色绘制原语与 freehand/FreehandStage 同源（后续可抽 painter.ts 去重）。
 * 导出/视觉自检经 ref 暴露 toDataURL(pixelRatio)：渲染干净整幅（无笔尖、无选中框）。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { getStroke } from 'perfect-freehand'
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../dsl'
import { getBBox, type SceneObject, type SceneState } from '../engine/scene'
import { objectToStrokes, vpathToStrokes } from '../freehand/fromScene'
import {
  cumulativeLengths,
  densifyLinear,
  roughen,
  sampleCenterline,
  sliceUpTo,
  tipAt,
  type Pt,
  type Stroke,
} from '../freehand/engine'

const W = CANVAS_WIDTH
const H = CANVAS_HEIGHT
const INK = '#2b2b2b'
const PAPER = '#f6f0e4'

// 主应用增量绘制：比 ?freehand 演示快些（少等），仍看得清运笔过程
const SPEED = 1100 // 运笔速度 px/s
const TRAVEL_S = 0.16 // 笔画间抬笔位移时长
const FILL_ROW_GAP = 10 // 着色横扫行距
const FILL_SPEED = 2400 // 着色运笔速度 px/s
const FILL_PEN_W = 14 // 着色笔宽（>行距 → 行间叠满无缝）

const ease = (t: number) => t * t * (3 - 2 * t)
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

function bboxOf(pts: Pt[]): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX - minX, maxY - minY]
}

/** 水平扫描线与多边形求交：y 处落在形内的 [x0,x1] 区间（升序成对，半开判定避免顶点重复） */
function spansAtY(poly: Pt[], y: number): Array<[number, number]> {
  const xs: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
      xs.push(a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]))
    }
  }
  xs.sort((p, q) => p - q)
  const spans: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]])
  return spans
}

/** 轮廓多边形 → 横向来回（boustrophedon）着色运笔中心线 */
function buildFillPath(poly: Pt[], bbox: [number, number, number, number]): Pt[] {
  const [, by, , bh] = bbox
  const out: Pt[] = []
  let row = 0
  for (let y = by + FILL_ROW_GAP / 2; y < by + bh; y += FILL_ROW_GAP, row++) {
    let spans = spansAtY(poly, y)
    if (spans.length === 0) continue
    if (row % 2 === 1) spans = spans.reverse().map(([a, b]) => [b, a] as [number, number])
    for (const [x0, x1] of spans) out.push([x0, y], [x1, y])
  }
  return out
}

interface Prepared {
  s: Stroke
  pts: Pt[]
  cum: number[]
  total: number
  fillPath: Pt[]
  fillCum: number[]
  fillLen: number
}

/** Stroke → Prepared（采样/稠密化 + 弧长表 + 着色蛇形路径），主应用恒清晰 roughness=0 */
function prepareStroke(s: Stroke, seed: number): Prepared {
  const anchors = roughen(s.pts, s.closed ?? false, 0, seed)
  const pts =
    s.smooth === false ? densifyLinear(anchors, s.closed ?? false, 7) : sampleCenterline(anchors, s.closed ?? false, 18)
  const cum = cumulativeLengths(pts)
  const bbox = bboxOf(pts)
  const fillPath = s.closed && s.fill && pts.length >= 3 ? buildFillPath(pts, bbox) : []
  const fillCum = cumulativeLengths(fillPath)
  return { s, pts, cum, total: cum[cum.length - 1] ?? 0, fillPath, fillCum, fillLen: fillCum[fillCum.length - 1] ?? 0 }
}

const fillable = (p: Prepared) => p.fillPath.length >= 2
// 时长加帽：每件封顶，避免 plan 多部件（如 vpath 主体 10~20 件）逐笔累计到几十秒——
// 目标整幅"十几秒"画完。填色是大头故帽更低；小件仍有下限保证看得清运笔，不一闪而过。
const fillDur = (p: Prepared) => Math.min(0.6, Math.max(0.28, p.fillLen / FILL_SPEED))
const drawDur = (p: Prepared) => Math.min(0.7, Math.max(0.12, p.total / SPEED))

/** 描周界：闭合形描线（直边保直、圆保圆），开放笔走 perfect-freehand 变宽墨带 */
function paintStroke(tctx: CanvasRenderingContext2D, p: Prepared, L: number): void {
  const slice = sliceUpTo(p.pts, p.cum, L)
  if (slice.length < 2) return
  if (p.s.closed) {
    const complete = L >= p.total
    tctx.beginPath()
    tctx.moveTo(slice[0][0], slice[0][1])
    for (let k = 1; k < slice.length; k++) tctx.lineTo(slice[k][0], slice[k][1])
    if (complete) tctx.closePath()
    tctx.lineWidth = p.s.width ?? 6
    tctx.strokeStyle = p.s.color ?? INK
    tctx.lineJoin = 'round'
    tctx.lineCap = 'round'
    tctx.stroke()
    return
  }
  const w = p.s.width ?? 8
  const taper = p.s.taper !== false
  const straight = p.s.smooth === false
  const outline = getStroke(slice as number[][], {
    size: w,
    thinning: 0,
    smoothing: straight ? 0 : 0.62,
    streamline: straight ? 0 : 0.32,
    simulatePressure: false,
    last: L >= p.total,
    start: { cap: !taper, taper: taper ? w * 2.5 : 0 },
    end: { cap: !taper, taper: taper ? w * 2.5 : 0 },
  })
  if (outline.length < 3) return
  tctx.beginPath()
  tctx.moveTo(outline[0][0], outline[0][1])
  for (const pt of outline) tctx.lineTo(pt[0], pt[1])
  tctx.closePath()
  tctx.fillStyle = p.s.color ?? INK
  tctx.fill()
}

/** 横向来回着色（clip 形内，沿蛇形按弧长渐进，圆头满宽 → 行间叠满无缝），fr=进度 0~1 */
function fillClosed(tctx: CanvasRenderingContext2D, p: Prepared, fr: number): void {
  if (p.fillPath.length < 2 || !p.s.fill) return
  const slice = sliceUpTo(p.fillPath, p.fillCum, fr * p.fillLen)
  if (slice.length < 2) return
  tctx.save()
  tctx.beginPath()
  tctx.moveTo(p.pts[0][0], p.pts[0][1])
  for (let k = 1; k < p.pts.length; k++) tctx.lineTo(p.pts[k][0], p.pts[k][1])
  tctx.closePath()
  tctx.clip()
  tctx.strokeStyle = p.s.fill
  tctx.lineCap = 'round'
  tctx.lineJoin = 'round'
  tctx.lineWidth = FILL_PEN_W
  tctx.beginPath()
  tctx.moveTo(slice[0][0], slice[0][1])
  for (let k = 1; k < slice.length; k++) tctx.lineTo(slice[k][0], slice[k][1])
  tctx.stroke()
  tctx.restore()
}

/** 整形实色填满：兜底扫描死角（底尖/月牙），保证落定无缺色 */
function solidFill(tctx: CanvasRenderingContext2D, p: Prepared): void {
  if (!p.s.fill || p.pts.length < 3) return
  tctx.save()
  tctx.fillStyle = p.s.fill
  tctx.beginPath()
  tctx.moveTo(p.pts[0][0], p.pts[0][1])
  for (let k = 1; k < p.pts.length; k++) tctx.lineTo(p.pts[k][0], p.pts[k][1])
  tctx.closePath()
  tctx.fill()
  tctx.restore()
}

const fillTip = (p: Prepared, fr: number) => tipAt(p.fillPath, p.fillCum, fr * p.fillLen)

/** 落定的一笔：先实色填满（闭合带填充），再描周界于其上 */
function bakeStroke(tctx: CanvasRenderingContext2D, p: Prepared): void {
  if (p.s.closed && p.s.fill) solidFill(tctx, p)
  paintStroke(tctx, p, p.total)
}

/** 画笔光标：笔随运动方向倾斜（右移右倾、左移左倾），始终竖立 */
function drawPen(ctx: CanvasRenderingContext2D, pos: Pt, angle: number, lifted: boolean): void {
  ctx.save()
  if (lifted) {
    ctx.save()
    ctx.fillStyle = 'rgba(40,32,24,0.16)'
    ctx.beginPath()
    ctx.ellipse(pos[0] + 6, pos[1] + 10, 9, 4, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  ctx.translate(pos[0], pos[1] - (lifted ? 9 : 0))
  ctx.rotate(0.62 * Math.cos(angle) - 0.12)
  ctx.fillStyle = '#1c1c1c'
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-5, -17)
  ctx.lineTo(5, -17)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#cfc8b8'
  ctx.fillRect(-6, -23, 12, 6)
  ctx.fillStyle = '#E8743B'
  ctx.beginPath()
  ctx.moveTo(-6, -23)
  ctx.lineTo(6, -23)
  ctx.lineTo(6, -66)
  ctx.quadraticCurveTo(0, -74, -6, -66)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 签名：可视字段变化才触发重画（忽略 id/name/groupId/createdSeq；z 计入以保正确层序） */
function sigOf(o: SceneObject): string {
  const { id: _id, name: _name, groupId: _g, createdSeq: _c, ...rest } = o as SceneObject & { createdSeq?: number }
  return JSON.stringify(rest)
}

function prepareObject(o: SceneObject): Prepared[] {
  // vpath：把 d 采样成轮廓折线笔触（逐笔手绘动画用）；其余图元走组件引擎拆解
  const strokes = o.shape === 'vpath' ? vpathToStrokes(o) : objectToStrokes(o)
  return strokes.map((s, i) => prepareStroke(s, (o.z + 1) * 0x9e3779b1 + i))
}

/** 线性渐变（schema：angle 0=左→右 90=上→下），跨给定 bbox 铺设 */
function linearGrad(
  ctx: CanvasRenderingContext2D,
  g: NonNullable<SceneObject['gradient']>,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): CanvasGradient {
  const rad = ((g.angle ?? 90) * Math.PI) / 180
  const cx = bx + bw / 2
  const cy = by + bh / 2
  const dx = (Math.cos(rad) * bw) / 2
  const dy = (Math.sin(rad) * bh) / 2
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  grad.addColorStop(0, g.from)
  grad.addColorStop(1, g.to)
  return grad
}

/** 从 d 抽坐标算局部包围盒（限定 M/L/C/Q/Z），供渐变铺设 */
function pathLocalBBox(d: string): [number, number, number, number] {
  const nums = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i])
    maxX = Math.max(maxX, nums[i])
    minY = Math.min(minY, nums[i + 1])
    maxY = Math.max(maxY, nums[i + 1])
  }
  return Number.isFinite(minX) ? [minX, minY, maxX - minX, maxY - minY] : [0, 0, 0, 0]
}

/** v2.0 vpath：清晰矢量渲染（Path2D 填充+描边）+ 真渐变 + 柔和投影（贴纸级层次，确定性精修）。 */
function drawVPath(ctx: CanvasRenderingContext2D, o: SceneObject): void {
  if (!o.d) return
  let path: Path2D
  try {
    path = new Path2D(o.d)
  } catch {
    return // d 语法非法 → 跳过（不崩）
  }
  ctx.save()
  if (o.x || o.y) ctx.translate(o.x, o.y) // move：平移偏移
  if (o.rotation) {
    // rotate：绕 d 包围盒中心旋转（getBBox 按 §5.5 不计旋转，与图元一致）
    const [bx, by, bw, bh] = pathLocalBBox(o.d)
    const cx = bx + bw / 2
    const cy = by + bh / 2
    ctx.translate(cx, cy)
    ctx.rotate((o.rotation * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }
  if (o.opacity !== undefined) ctx.globalAlpha = o.opacity
  // 柔和投影：每件极淡阴影 → 贴纸式层次（仅作用填充，描边时关掉防重影；接地阴影另补整体落地感）
  ctx.shadowColor = 'rgba(0,0,0,0.12)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 2
  if (o.gradient) {
    const [bx, by, bw, bh] = pathLocalBBox(o.d)
    ctx.fillStyle = linearGrad(ctx, o.gradient, bx, by, bw, bh)
    ctx.fill(path)
  } else if (o.fill) {
    ctx.fillStyle = o.fill
    ctx.fill(path)
  }
  if (o.stroke) {
    ctx.shadowColor = 'transparent'
    ctx.strokeStyle = o.stroke
    ctx.lineWidth = o.strokeWidth ?? 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.stroke(path)
  }
  ctx.restore()
}

/** 渐变大色块（天空/草地等背景）走清晰渐变填充（非手绘）——比纯色/手绘更精致 */
function drawCrispFill(ctx: CanvasRenderingContext2D, o: SceneObject): void {
  const [bx, by, bw, bh] = getBBox(o)
  ctx.save()
  if (o.opacity !== undefined) ctx.globalAlpha = o.opacity
  ctx.fillStyle = o.gradient ? linearGrad(ctx, o.gradient, bx, by, bw, bh) : (o.fill ?? '#ffffff')
  const r = o.cornerRadius ?? 0
  if (r > 0 && typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, bh, r)
    ctx.fill()
  } else {
    ctx.fillRect(bx, by, bw, bh)
  }
  ctx.restore()
}

/** v2.0 文字渲染：自由画笔引擎不拆手写字形，按中心点用原生 fillText 呈现（CJK 可读、字体即时无 FOUT）。
 *  字号/居中与 getBBox(scene.ts §text：fontSize、中心 y、宽=字数×fs)对齐 → 相对定位不偏；
 *  honor rotation/opacity，有 stroke 时先描边后填充（描边色当轮廓，类似手写双色字）。 */
function drawText(ctx: CanvasRenderingContext2D, o: SceneObject): void {
  const text = o.text ?? ''
  if (text.length === 0) return
  const fs = o.fontSize ?? 16
  ctx.save()
  if (o.opacity !== undefined) ctx.globalAlpha = o.opacity
  if (o.rotation) {
    ctx.translate(o.x, o.y)
    ctx.rotate((o.rotation * Math.PI) / 180)
    ctx.translate(-o.x, -o.y)
  }
  ctx.font = `600 ${fs}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (o.stroke) {
    ctx.strokeStyle = o.stroke
    ctx.lineWidth = o.strokeWidth ?? Math.max(2, fs * 0.08)
    ctx.lineJoin = 'round'
    ctx.strokeText(text, o.x, o.y)
  }
  ctx.fillStyle = o.fill ?? INK
  ctx.fillText(text, o.x, o.y)
  ctx.restore()
}

/** v1.7 纹理 tile：透明底 + 暗纹（16×16 平铺，叠在已填充底色之上）。按类型缓存。
 *  注：底色不画进 tile（与旧 Konva 版 fillPriority 不同）——这里走"实色填充 + 暗纹叠加"，
 *  契合规格"在 fill 底色上叠暗纹"，且不覆盖描边轮廓。 */
const patternCache = new Map<string, HTMLCanvasElement>()
function patternTile(type: NonNullable<SceneObject['pattern']>): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined
  const cached = patternCache.get(type)
  if (cached) return cached
  const S = 16
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const tctx = c.getContext('2d')
  if (tctx === null) return undefined
  const mark = 'rgba(0,0,0,0.2)'
  tctx.fillStyle = mark
  tctx.strokeStyle = mark
  tctx.lineWidth = 2
  switch (type) {
    case 'stripes':
      tctx.fillRect(0, 0, 5, S) // 竖条
      break
    case 'dots':
      tctx.beginPath()
      tctx.arc(S / 2, S / 2, 2.4, 0, Math.PI * 2)
      tctx.fill()
      break
    case 'grid':
      tctx.fillRect(S - 1.5, 0, 1.5, S)
      tctx.fillRect(0, S - 1.5, S, 1.5)
      break
    case 'hatch':
      tctx.beginPath()
      tctx.moveTo(-4, S + 4)
      tctx.lineTo(S + 4, -4) // 单向斜纹（平铺连续）
      tctx.stroke()
      break
    case 'cross':
      tctx.beginPath()
      tctx.moveTo(-4, S + 4)
      tctx.lineTo(S + 4, -4)
      tctx.moveTo(-4, -4)
      tctx.lineTo(S + 4, S + 4) // 交叉斜纹
      tctx.stroke()
      break
  }
  patternCache.set(type, c)
  return c
}

/** 纹理叠加：在已实色填充的闭合形状内 clip 平铺暗纹 tile（衣纹/砖墙/鳞片/毛感）。
 *  仅作用闭合可填充笔触（开放线/无填充跳过）；在 bakeStroke 之后调用，叠在底色上。 */
function overlayPattern(
  ctx: CanvasRenderingContext2D,
  prepared: Prepared[],
  pattern: NonNullable<SceneObject['pattern']>,
): void {
  const tile = patternTile(pattern)
  if (!tile) return
  const cp = ctx.createPattern(tile, 'repeat')
  if (cp === null) return
  for (const p of prepared) {
    if (!p.s.closed || !p.s.fill || p.pts.length < 3) continue
    const [bx, by, bw, bh] = bboxOf(p.pts)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(p.pts[0][0], p.pts[0][1])
    for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k][0], p.pts[k][1])
    ctx.closePath()
    ctx.clip()
    ctx.fillStyle = cp
    ctx.fillRect(bx, by, bw, bh)
    ctx.restore()
  }
}

/** 把一个对象完整画到 ctx：vpath/文字/渐变背景走清晰矢量（含渐变+投影），其余图元走手绘笔触烘焙 */
function bakeObject(ctx: CanvasRenderingContext2D, o: SceneObject): void {
  if (o.shape === 'vpath') {
    drawVPath(ctx, o)
    return
  }
  if (o.shape === 'text') {
    drawText(ctx, o) // 文字：原生 fillText（不拆笔触）
    return
  }
  if (o.gradient && o.shape === 'rect') {
    drawCrispFill(ctx, o) // 渐变背景：清晰渐变（天空/草地）
    return
  }
  const prepared = prepareObject(o)
  for (const p of prepared) bakeStroke(ctx, p)
  if (o.pattern) overlayPattern(ctx, prepared, o.pattern) // v1.7 纹理叠在底色上
}

/** 主体（全部 vpath）并集包围盒——背景=非 vpath，识别干净 */
function vpathUnionBBox(objs: SceneObject[]): [number, number, number, number] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const o of objs) {
    if (o.shape !== 'vpath') continue
    const [bx, by, bw, bh] = getBBox(o)
    minX = Math.min(minX, bx)
    minY = Math.min(minY, by)
    maxX = Math.max(maxX, bx + bw)
    maxY = Math.max(maxY, by + bh)
    any = true
  }
  return any ? [minX, minY, maxX - minX, maxY - minY] : null
}

/** 接地阴影：主体脚下一道柔和椭圆影 → 主体"落地"不悬空（专业插画明暗层次）。画在背景之上、主体之下。 */
function drawGroundShadow(ctx: CanvasRenderingContext2D, bbox: [number, number, number, number]): void {
  const [x, y, w, h] = bbox
  ctx.save()
  ctx.filter = 'blur(7px)'
  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  ctx.beginPath()
  ctx.ellipse(x + w / 2, y + h * 0.99, w * 0.42, Math.max(8, h * 0.05), 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export interface FreehandCaptureHandle {
  /** 渲染干净整幅（无笔尖/选中框）→ PNG dataURL，供导出与视觉自检 */
  toDataURL: (pixelRatio?: number) => string
}

interface QueueItem {
  id: string
  sig: string
  prepared: Prepared[]
  pattern?: NonNullable<SceneObject['pattern']> // v1.7 纹理：落定时叠在底色上
  obj?: SceneObject // vpath：落定时改走清晰 Path2D（drawVPath），故需对象本体
}

interface AnimState {
  id: string
  sig: string
  prepared: Prepared[]
  pattern?: NonNullable<SceneObject['pattern']>
  obj?: SceneObject
  strokeI: number
  mode: 'draw' | 'fill' | 'travel'
  drawn: number
  fillFr: number
  travelT: number
  penFrom: Pt
  penTo: Pt
}

export const FreehandSceneStage = forwardRef<FreehandCaptureHandle, { scene: SceneState }>(function FreehandSceneStage(
  { scene },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<SceneState>(scene)
  // 跨渲染持久的绘制状态
  const committedRef = useRef<HTMLCanvasElement | null>(null) // 已落定对象的离屏画布
  const bakedSigRef = useRef<Map<string, string>>(new Map()) // id → 已烘焙的签名
  const queueRef = useRef<QueueItem[]>([]) // 待逐笔动画的对象
  const animRef = useRef<AnimState | null>(null)
  const dprRef = useRef(2)
  // 空闲即停：有动画/待画对象才转 rAF，画完停（省 CPU，不空转重绘）；场景变化经此重启
  const ensureRunningRef = useRef<() => void>(() => {})

  // 导出/自检：从当前场景干净重渲一帧（不依赖动画进度，无笔无选中）
  useImperativeHandle(
    ref,
    (): FreehandCaptureHandle => ({
      toDataURL: (pixelRatio = 2) => {
        const c = document.createElement('canvas')
        c.width = Math.round(W * pixelRatio)
        c.height = Math.round(H * pixelRatio)
        const tctx = c.getContext('2d')
        if (!tctx) return ''
        tctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
        tctx.fillStyle = PAPER
        tctx.fillRect(0, 0, W, H)
        const objsT = [...sceneRef.current.objects].sort((a, b) => a.z - b.z)
        const subjT = vpathUnionBBox(objsT)
        let groundT = false
        for (const o of objsT) {
          if (subjT && !groundT && o.shape === 'vpath') {
            drawGroundShadow(tctx, subjT)
            groundT = true
          }
          bakeObject(tctx, o)
        }
        return c.toDataURL('image/png')
      },
    }),
    [],
  )

  // 单次挂载：建离屏画布 + 定义 rAF 循环（空闲即停；画完停转，省 CPU）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.max(2, window.devicePixelRatio || 1)
    dprRef.current = dpr
    cv.width = W * dpr
    cv.height = H * dpr

    const committed = document.createElement('canvas')
    committed.width = W * dpr
    committed.height = H * dpr
    const cctx = committed.getContext('2d')
    if (!cctx) return
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    committedRef.current = committed

    let last = 0
    let raf = 0
    let running = false

    const startAnim = (item: QueueItem): AnimState | null => {
      if (item.prepared.length === 0) return null
      return {
        id: item.id,
        sig: item.sig,
        prepared: item.prepared,
        pattern: item.pattern,
        obj: item.obj,
        strokeI: 0,
        mode: 'draw',
        drawn: 0,
        fillFr: 0,
        travelT: 0,
        penFrom: item.prepared[0].pts[0],
        penTo: item.prepared[0].pts[0],
      }
    }

    // 落定整个对象：vpath 落定转清晰 Path2D（drawVPath，出渐变/投影最终质感）；
    // 其余图元逐笔烘焙进 committed（含纹理叠加）。记签名。
    const bakeAnim = (a: AnimState) => {
      if (a.obj && a.obj.shape === 'vpath') {
        bakeObject(cctx, a.obj) // 手绘轨迹只用于过程动画，落定换清晰矢量
      } else {
        for (const p of a.prepared) bakeStroke(cctx, p)
        if (a.pattern) overlayPattern(cctx, a.prepared, a.pattern) // v1.7 纹理叠在底色上
      }
      bakedSigRef.current.set(a.id, a.sig)
    }

    const render = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = PAPER
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(committed, 0, 0, W, H)
      const a = animRef.current
      let penPos: Pt | null = null
      let penAngle = 0
      let lifted = false
      if (a) {
        const cur = a.prepared[a.strokeI]
        if (a.mode === 'draw') {
          paintStroke(ctx, cur, a.drawn)
          const tip = tipAt(cur.pts, cur.cum, a.drawn)
          penPos = tip.pt
          penAngle = tip.angle
        } else if (a.mode === 'fill') {
          fillClosed(ctx, cur, a.fillFr)
          paintStroke(ctx, cur, cur.total)
          const tip = fillTip(cur, a.fillFr)
          penPos = tip.pt
          penAngle = tip.angle
        } else {
          penPos = lerp(a.penFrom, a.penTo, ease(Math.min(1, a.travelT)))
          penAngle = Math.atan2(a.penTo[1] - a.penFrom[1], a.penTo[0] - a.penFrom[0])
          lifted = true
        }
      }
      if (penPos) drawPen(ctx, penPos, penAngle, lifted)
    }

    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts

      if (animRef.current === null && queueRef.current.length > 0) {
        // 取下一个待画对象（跳过空笔触对象，仍记签名以免反复重排）
        let next = startAnim(queueRef.current.shift() as QueueItem)
        while (next === null && queueRef.current.length > 0) {
          const skipped = queueRef.current.shift() as QueueItem
          bakedSigRef.current.set(skipped.id, skipped.sig)
          next = startAnim({ ...skipped, prepared: skipped.prepared })
        }
        animRef.current = next
      }

      const a = animRef.current
      if (a) {
        const cur = a.prepared[a.strokeI]
        if (a.mode === 'draw') {
          a.drawn += (cur.total / drawDur(cur)) * dt // 按封顶时长推进（大件提速、小件保下限）
          if (a.drawn >= cur.total) {
            a.drawn = cur.total
            if (fillable(cur)) {
              a.mode = 'fill'
              a.fillFr = 0
            } else {
              advanceStroke(a)
            }
          }
        } else if (a.mode === 'fill') {
          a.fillFr += dt / fillDur(cur)
          if (a.fillFr >= 1) {
            a.fillFr = 1
            advanceStroke(a)
          }
        } else if (a.mode === 'travel') {
          a.travelT += dt / TRAVEL_S
          if (a.travelT >= 1) {
            a.strokeI++
            a.drawn = 0
            a.mode = 'draw'
          }
        }
      }

      render()
      // 空闲（无动画、无待画）→ 渲染最后一帧后停转，不再 reschedule，省 CPU
      if (animRef.current === null && queueRef.current.length === 0) {
        running = false
        return
      }
      raf = requestAnimationFrame(frame)
    }

    // 一笔（周界+填色）完成：还有下一笔则抬笔位移过去，否则整对象落定
    const advanceStroke = (a: AnimState) => {
      const nextStroke = a.prepared[a.strokeI + 1]
      if (nextStroke) {
        a.penFrom = a.prepared[a.strokeI].pts[a.prepared[a.strokeI].pts.length - 1]
        a.penTo = nextStroke.pts[0]
        a.mode = 'travel'
        a.travelT = 0
      } else {
        bakeAnim(a)
        animRef.current = null
      }
    }

    // 启动（幂等）：场景变化入队后调用，停转则重启循环
    const ensureRunning = () => {
      if (running) return
      running = true
      last = 0
      raf = requestAnimationFrame(frame)
    }
    ensureRunningRef.current = ensureRunning
    ensureRunning() // 首帧：渲染初始（含已有场景的入队对象）

    return () => {
      cancelAnimationFrame(raf)
      running = false
    }
  }, [])

  // 场景变化：diff → 重建 committed（稳定对象瞬时静态绘）+ 入队新增/改动对象
  useEffect(() => {
    sceneRef.current = scene
    const cctx = committedRef.current?.getContext('2d')
    if (!cctx) return
    const objs = [...scene.objects].sort((a, b) => a.z - b.z)
    const ids = new Set(objs.map((o) => o.id))
    const baked = bakedSigRef.current

    // 删除的对象：从已烘焙集移除（重建时不再画 → 抹除/橡皮擦）
    for (const id of [...baked.keys()]) if (!ids.has(id)) baked.delete(id)

    // 新增/改动对象：入队逐笔动画（改动则先撤销旧签名，committed 重建时排除旧态）
    for (const o of objs) {
      const sig = sigOf(o)
      if (baked.get(o.id) === sig) continue // 已落定且未变
      // 文字与背景大块即时烘焙（不走逐笔动画）：
      //  - 背景 z 最低，若走动画队列会在主体（已落定）之后铺满、把主体盖掉（"画一半清空"），故即时排 z 序下；
      //  - 文字不拆字形（objectToStrokes 对 text 返回空），走队列会被当空笔触跳过而不显示（曾回归），故即时。
      // vpath 主体不再即时——采样成轮廓折线走逐笔动画（看绘制过程），落定再转清晰矢量（bakeAnim 走 drawVPath）。
      const isBgRect = o.shape === 'rect' && (o.gradient !== undefined || getBBox(o)[2] >= 0.85 * W)
      const dropFromQueue = () => {
        const qv = queueRef.current.findIndex((q) => q.id === o.id)
        if (qv >= 0) queueRef.current.splice(qv, 1)
      }
      if (o.shape === 'text' || isBgRect) {
        dropFromQueue()
        baked.set(o.id, sig)
        continue
      }
      const prepared = prepareObject(o) // vpath→轮廓折线；图元→手绘笔触
      if (prepared.length === 0) {
        // 采样失败（如非法 vpath d）→ 即时清晰矢量兜底（committed 重建走 bakeObject→drawVPath），避免不显示
        dropFromQueue()
        baked.set(o.id, sig)
        continue
      }
      const a = animRef.current
      if (a && a.id === o.id && a.sig === sig) continue // 正在画且一致
      const qi = queueRef.current.findIndex((q) => q.id === o.id)
      if (qi >= 0 && queueRef.current[qi].sig === sig) continue // 已在队列且一致
      baked.delete(o.id)
      if (qi >= 0) queueRef.current.splice(qi, 1)
      queueRef.current.push({ id: o.id, sig, prepared, pattern: o.pattern, obj: o })
      if (a && a.id === o.id) animRef.current = null // 改动正在画的对象 → 重启
    }

    // 重建 committed：仅画已落定（签名在 baked）的对象，瞬时静态、不重放动画
    const dpr = dprRef.current
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cctx.clearRect(0, 0, W, H)
    const subjBBox = vpathUnionBBox(objs)
    let groundDrawn = false
    for (const o of objs) {
      if (subjBBox && !groundDrawn && o.shape === 'vpath') {
        drawGroundShadow(cctx, subjBBox) // 主体之下、背景之上：落地阴影
        groundDrawn = true
      }
      if (!baked.has(o.id)) continue
      bakeObject(cctx, o)
    }

    // 重启循环：播放新增/改动对象的逐笔动画；无新活时也渲一帧（更新选中框/抹除）
    ensureRunningRef.current()
  }, [scene])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${W}px`, height: `${H}px`, display: 'block' }}
      aria-label="自由画笔画布"
    />
  )
})
