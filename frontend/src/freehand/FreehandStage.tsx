/**
 * 自由画笔 · 绘制过程演示（research：feat/freehand-pen）
 * 在画布上用「会动的笔」逐笔把一幅墨线速写画出来——演示自由画笔引擎：
 * 变宽墨带 + 弧长匀速运笔 + 渐进显墨 + 笔尖沿轨迹移动 + 抬笔换行。
 * 访问 http://localhost:5174/?freehand 查看。
 */
import { useEffect, useRef, useState } from 'react'
import { getStroke } from 'perfect-freehand'
import {
  cumulativeLengths,
  densifyLinear,
  roughen,
  sampleCenterline,
  sliceUpTo,
  tipAt,
  type Pt,
  type Stroke,
} from './engine'

const W = 1024
const H = 768
const INK = '#2b2b2b'

/** 椭圆弧采样（生成 demo 笔画的锚点） */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt
  })
}

/** demo：一只墨线速写小猫（每个元素是一"笔"，按数组顺序逐笔画出） */
export const CAT_DEMO: Stroke[] = [
  { pts: arc(512, 392, 150, 140, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.96, 26), color: INK, width: 9, taper: true },
  { pts: [[430, 282], [402, 200], [486, 258]], color: INK, width: 9, taper: true },
  { pts: [[594, 282], [622, 200], [538, 258]], color: INK, width: 9, taper: true },
  { pts: arc(458, 372, 17, 22, 0, Math.PI * 2, 16), closed: true, color: INK, fill: '#222', width: 3 },
  { pts: arc(566, 372, 17, 22, 0, Math.PI * 2, 16), closed: true, color: INK, fill: '#222', width: 3 },
  { pts: arc(478, 366, 5, 6, 0, Math.PI * 2, 10), closed: true, color: '#fff', fill: '#fff', width: 1 },
  { pts: arc(586, 366, 5, 6, 0, Math.PI * 2, 10), closed: true, color: '#fff', fill: '#fff', width: 1 },
  { pts: [[512, 410], [500, 400], [524, 400]], closed: true, color: '#E07090', fill: '#F4A0BC', width: 2 },
  { pts: [[490, 430], [512, 444], [534, 430]], color: INK, width: 5, taper: true },
  { pts: [[466, 408], [388, 398]], color: INK, width: 3, taper: true },
  { pts: [[466, 420], [390, 426]], color: INK, width: 3, taper: true },
  { pts: [[558, 408], [636, 398]], color: INK, width: 3, taper: true },
  { pts: [[558, 420], [634, 426]], color: INK, width: 3, taper: true },
]

interface Prepared {
  s: Stroke
  pts: Pt[]
  cum: number[]
  total: number
  bbox: [number, number, number, number] // [x,y,w,h]
  fillPath: Pt[] // 横向来回直线扫描的着色运笔中心线（clip 到形内逐行涂满，起笔即满宽不缺失）
  fillCum: number[]
  fillLen: number // 蛇形总弧长（着色总运笔长度）
}

const SPEED = 400 // 运笔速度 px/s（适中观感，便于看清绘制过程）
const TRAVEL_S = 0.3 // 抬笔换行时长
const FILL_ROW_GAP = 10 // 着色横扫行距 px（一行一行往下涂）
const FILL_SPEED = 700 // 着色运笔速度 px/s（横向来回扫，放慢以看清一行行推进）
const FILL_PEN_W = 14 // 着色笔宽 px（圆头、略宽于行距 → 行间叠满无缝）
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

/** 水平扫描线与多边形求交：返回 y 处落在形内的 [x0,x1] 区间（升序、成对）。半开判定避免顶点重复计数。 */
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

/** 由轮廓多边形生成"横着一行一行往下、左右来回（boustrophedon）"的着色直线蛇形运笔中心线。
 *  逐行求交得形内横段（直线段），奇偶行反向 → 转折处相连成往复笔触；clip 到形内防溢出。
 *  行距<笔宽 → 行间叠满涂实；圆头满宽一笔描，起笔即满宽 → 起笔不缺失。 */
function buildFillPath(poly: Pt[], bbox: [number, number, number, number]): Pt[] {
  const [, by, , bh] = bbox
  const out: Pt[] = []
  let row = 0
  for (let y = by + FILL_ROW_GAP / 2; y < by + bh; y += FILL_ROW_GAP, row++) {
    let spans = spansAtY(poly, y)
    if (spans.length === 0) continue
    if (row % 2 === 1) spans = spans.reverse().map(([a, b]) => [b, a] as [number, number]) // 反向行：从右往左
    for (const [x0, x1] of spans) out.push([x0, y], [x1, y]) // 直线横段
  }
  return out
}

export function FreehandStage({
  strokes = CAT_DEMO,
  title,
  roughness = 0,
}: {
  strokes?: Stroke[]
  title?: string
  roughness?: number // 手绘抖动幅度 px（缺省 0=直线笔直、圆顺滑；>0 才加手画弓形感，可选）
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [runId, setRunId] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.max(2, window.devicePixelRatio || 1)
    cv.width = W * dpr
    cv.height = H * dpr
    setDone(false)

    // 已完成的笔提交到离屏画布（每笔只画一次）；逐帧只重绘"当前正在画的一笔"+笔尖，
    // 开销恒定、不随笔数增长 → 不再一卡一卡（此前每帧对所有完成笔都重跑 getStroke+填充）
    const committed = document.createElement('canvas')
    committed.width = W * dpr
    committed.height = H * dpr
    const cctx = committed.getContext('2d')
    if (!cctx) return
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const prep: Prepared[] = strokes.map((s, i) => {
      // 先手绘抖动（确定性 seed=笔序，逐帧稳定），再平滑/稠密化
      const anchors = roughen(s.pts, s.closed ?? false, roughness, i * 0x9e3779b1 + 1)
      // smooth=false（多边形/矩形）走线性稠密化保棱角；否则向心 CR 平滑
      const pts =
        s.smooth === false ? densifyLinear(anchors, s.closed ?? false, 7) : sampleCenterline(anchors, s.closed ?? false, 18)
      const cum = cumulativeLengths(pts)
      const bbox = bboxOf(pts)
      // 预生成着色运笔：横着一行行往下、来回直线横扫（clip 到形内；起笔即满宽，无缺失）
      const fillPath = s.closed && s.fill && pts.length >= 3 ? buildFillPath(pts, bbox) : []
      const fillCum = cumulativeLengths(fillPath)
      return { s, pts, cum, total: cum[cum.length - 1], bbox, fillPath, fillCum, fillLen: fillCum[fillCum.length - 1] ?? 0 }
    })

    let strokeI = 0
    let drawn = 0
    let mode: 'draw' | 'fill' | 'travel' | 'end' = 'draw'
    let travelT = 0
    let fillFr = 0 // 当前笔填色进度 0~1
    let penFrom: Pt = prep[0].pts[0]
    let penTo: Pt = prep[0].pts[0]
    let last = 0
    let raf = 0

    const fillable = (p: Prepared) => p.fillPath.length >= 2
    const fillDur = (p: Prepared) => Math.max(0.4, p.fillLen / FILL_SPEED) // 按总运笔长定时长

    // 横着一行一行着色：clip 形内，沿"来回直线扫描"按弧长渐进上色，圆头满宽一笔描（行距 < 笔宽 →
    // 行间必叠满、涂实，转折处圆角相接、自相交也无缝；起笔即满宽 → 起笔不缺失，全程彻底涂满）。fr=进度 0~1。
    const fillClosed = (tctx: CanvasRenderingContext2D, p: Prepared, fr: number) => {
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
    // 着色时笔尖位置 + 切向角（沿弧形横扫方向，供笔随运动改变方向）
    const fillTip = (p: Prepared, fr: number) => tipAt(p.fillPath, p.fillCum, fr * p.fillLen)
    // 落定提交时整形实色填满：兜底任何行扫到不了的死角（底尖/边缘月牙），保证成图彻底无缺色。
    // 与填色同色、不可见，仅补足；动画过程仍由上面 fillClosed 一行行画出。
    const solidFill = (tctx: CanvasRenderingContext2D, p: Prepared) => {
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

    const paintStroke = (tctx: CanvasRenderingContext2D, p: Prepared, L: number) => {
      const slice = sliceUpTo(p.pts, p.cum, L)
      if (slice.length < 2) return
      // 闭合形状：只描周界（直边保持直、圆保持圆，过程=结果）；填色由 fill 阶段单独"用笔涂"。
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
      // 开放笔画：perfect-freehand 变宽墨带（恒定笔宽消除逐帧抖动，仅两端 taper 保留收笔笔感）。
      // 直线类（smooth=false）关平滑，避免把直笔画弯；有机线保留平滑。
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

    const drawPen = (pos: Pt, angle: number, lifted: boolean) => {
      ctx.save()
      if (lifted) {
        // 抬笔投影
        ctx.save()
        ctx.fillStyle = 'rgba(40,32,24,0.16)'
        ctx.beginPath()
        ctx.ellipse(pos[0] + 6, pos[1] + 10, 9, 4, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      ctx.translate(pos[0], pos[1] - (lifted ? 9 : 0))
      // 笔随运动改变方向：笔杆朝运动的水平分量倾斜（右移→右倾、左移→左倾），始终竖立不倒插
      ctx.rotate(0.62 * Math.cos(angle) - 0.12)
      // 笔尖
      ctx.fillStyle = '#1c1c1c'
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-5, -17)
      ctx.lineTo(5, -17)
      ctx.closePath()
      ctx.fill()
      // 金属箍
      ctx.fillStyle = '#cfc8b8'
      ctx.fillRect(-6, -23, 12, 6)
      // 笔杆
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

    const render = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#f6f0e4'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(committed, 0, 0, W, H) // 已完成的笔（离屏，每笔只画一次）一次性贴上
      // 仅重绘当前正在画/填的一笔 + 笔尖
      let penPos: Pt = penFrom
      let penAngle = 0
      let lifted = false
      const cur = prep[strokeI]
      if (mode === 'draw' && cur) {
        paintStroke(ctx, cur, drawn)
        const tip = tipAt(cur.pts, cur.cum, drawn)
        penPos = tip.pt
        penAngle = tip.angle
      } else if (mode === 'fill' && cur) {
        fillClosed(ctx, cur, fillFr) // 填色在下
        paintStroke(ctx, cur, cur.total) // 周界在上
        const tip = fillTip(cur, fillFr)
        penPos = tip.pt
        penAngle = tip.angle
      } else if (mode === 'travel') {
        penPos = lerp(penFrom, penTo, ease(Math.min(1, travelT)))
        penAngle = Math.atan2(penTo[1] - penFrom[1], penTo[0] - penFrom[0])
        lifted = true
      }
      if (mode !== 'end') drawPen(penPos, penAngle, lifted)
    }

    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const gotoTravelOrEnd = () => {
        const next = prep[strokeI + 1]
        if (next) {
          penTo = next.pts[0]
          mode = 'travel'
          travelT = 0
        } else {
          mode = 'end'
        }
      }
      if (mode === 'draw') {
        drawn += SPEED * dt
        const cur = prep[strokeI]
        if (drawn >= cur.total) {
          drawn = cur.total
          if (fillable(cur)) {
            mode = 'fill' // 周界描完 → 进入"用笔慢慢填色"阶段
            fillFr = 0
          } else {
            paintStroke(cctx, cur, cur.total) // 无需填色：直接提交周界到离屏层
            penFrom = cur.pts[cur.pts.length - 1]
            gotoTravelOrEnd()
          }
        }
      } else if (mode === 'fill') {
        const cur = prep[strokeI]
        fillFr += dt / fillDur(cur)
        if (fillFr >= 1) {
          fillFr = 1
          solidFill(cctx, cur) // 提交：整形实色填满（兜底死角，彻底无缺色）
          paintStroke(cctx, cur, cur.total) // 再描周界（覆于填色之上）
          penFrom = fillTip(cur, 1).pt
          gotoTravelOrEnd()
        }
      } else if (mode === 'travel') {
        travelT += dt / TRAVEL_S
        if (travelT >= 1) {
          strokeI++
          drawn = 0
          mode = 'draw'
        }
      }
      render()
      if (mode === 'end') {
        setDone(true)
        return
      }
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [runId, strokes, roughness])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#efe9dd',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '28px 16px',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <strong style={{ fontSize: 22, letterSpacing: 1 }}>自由画笔 · FREEHAND</strong>
        <span style={{ color: '#8a8170', fontSize: 13 }}>
          {title ?? 'research / feat/freehand-pen — 变宽墨带 · 弧长运笔 · 渐进显墨 · 笔尖动画'}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: 'min(92vw, 980px)',
          aspectRatio: `${W} / ${H}`,
          height: 'auto',
          borderRadius: 10,
          boxShadow: '14px 14px 0 0 #1FA6A0, 14px 14px 0 2px #2b2b2b, 0 12px 28px rgba(40,32,24,0.18)',
          background: '#f6f0e4',
        }}
      />
      <button
        onClick={() => setRunId((n) => n + 1)}
        style={{
          padding: '8px 20px',
          fontSize: 14,
          fontFamily: 'inherit',
          border: '2px solid #2b2b2b',
          borderRadius: 8,
          background: done ? '#FFD23F' : '#fff',
          cursor: 'pointer',
        }}
      >
        {done ? '↻ 重画一遍' : '绘制中…'}
      </button>
    </div>
  )
}
