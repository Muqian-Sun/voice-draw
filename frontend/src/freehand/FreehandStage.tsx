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
  fillPasses: Array<{ x0: number; x1: number; y: number }> // 着色的一道道横扫笔道（蛇形交替方向）
}

const SPEED = 400 // 运笔速度 px/s（适中观感，便于看清绘制过程）
const TRAVEL_S = 0.3 // 抬笔换行时长
const FILL_GAP = 10 // 着色笔道行距 px（细腻、不粗）
const FILL_PASS_SEC = 0.1 // 每道扫色时长 s（"慢慢一笔一笔"着色）
const FILL_PEN_W = 14 // 着色笔宽 px（每道用 perfect-freehand 两端收笔 → 触压感；略宽于行距 → 实色叠满无缝）
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
      // 预生成着色笔道：自上而下逐行横扫，方向交替（蛇形），每行一道实色笔道
      const fillPasses: Array<{ x0: number; x1: number; y: number }> = []
      if (s.closed && s.fill) {
        const [bx, by, bw, bh] = bbox
        const rows = Math.max(1, Math.ceil(bh / FILL_GAP))
        for (let r = 0; r < rows; r++) {
          const y = by + Math.min(bh, (r + 0.5) * FILL_GAP)
          fillPasses.push(r % 2 === 0 ? { x0: bx, x1: bx + bw, y } : { x0: bx + bw, x1: bx, y })
        }
      }
      return { s, pts, cum, total: cum[cum.length - 1], bbox, fillPasses }
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

    const fillable = (p: Prepared) => p.fillPasses.length > 0
    const fillDur = (p: Prepared) => Math.max(0.3, p.fillPasses.length * FILL_PASS_SEC) // 按笔道数定时长

    // 用笔一道一道着色：clip 形内，每道用 perfect-freehand 描成**两端收笔**的实色笔道（细、有触压感），
    // 相邻道略叠 → 实色无缝（无浓淡）。动画上看得见笔来回一道道涂。fr=填色进度 0~1。
    const paintPass = (tctx: CanvasRenderingContext2D, fill: string, x0: number, x1: number, y: number) => {
      const outline = getStroke(
        [
          [x0, y],
          [x1, y],
        ],
        { size: FILL_PEN_W, thinning: 0, simulatePressure: false, start: { cap: false, taper: FILL_PEN_W * 1.1 }, end: { cap: false, taper: FILL_PEN_W * 1.1 } },
      )
      if (outline.length < 3) return
      tctx.beginPath()
      tctx.moveTo(outline[0][0], outline[0][1])
      for (const pt of outline) tctx.lineTo(pt[0], pt[1])
      tctx.closePath()
      tctx.fillStyle = fill
      tctx.fill()
    }
    const fillClosed = (tctx: CanvasRenderingContext2D, p: Prepared, fr: number) => {
      const n = p.fillPasses.length
      if (n === 0 || !p.s.fill) return
      tctx.save()
      tctx.beginPath()
      tctx.moveTo(p.pts[0][0], p.pts[0][1])
      for (let k = 1; k < p.pts.length; k++) tctx.lineTo(p.pts[k][0], p.pts[k][1])
      tctx.closePath()
      tctx.clip()
      const prog = fr * n
      const full = Math.min(n, Math.floor(prog))
      for (let i = 0; i < full; i++) {
        const ps = p.fillPasses[i]
        paintPass(tctx, p.s.fill, ps.x0, ps.x1, ps.y)
      }
      if (full < n) {
        const ps = p.fillPasses[full]
        const x = ps.x0 + (ps.x1 - ps.x0) * (prog - full)
        paintPass(tctx, p.s.fill, ps.x0, x, ps.y)
      }
      tctx.restore()
    }
    // 填色时笔尖位置：当前道当前 x（蛇形交替方向）
    const fillPen = (p: Prepared, fr: number): Pt => {
      const n = p.fillPasses.length
      if (n === 0) return p.pts[0]
      const prog = Math.min(n, fr * n)
      const i = Math.min(n - 1, Math.floor(prog))
      const t = Math.min(1, prog - i)
      const ps = p.fillPasses[i]
      return [ps.x0 + (ps.x1 - ps.x0) * t, ps.y]
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

    const drawPen = (pos: Pt, lifted: boolean) => {
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
      ctx.rotate(-0.52)
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
      let lifted = false
      const cur = prep[strokeI]
      if (mode === 'draw' && cur) {
        paintStroke(ctx, cur, drawn)
        penPos = tipAt(cur.pts, cur.cum, drawn).pt
      } else if (mode === 'fill' && cur) {
        fillClosed(ctx, cur, fillFr) // 填色在下
        paintStroke(ctx, cur, cur.total) // 周界在上
        penPos = fillPen(cur, fillFr)
      } else if (mode === 'travel') {
        penPos = lerp(penFrom, penTo, ease(Math.min(1, travelT)))
        lifted = true
      }
      if (mode !== 'end') drawPen(penPos, lifted)
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
          fillClosed(cctx, cur, 1) // 提交：先填满
          paintStroke(cctx, cur, cur.total) // 再描周界（覆于填色之上）
          penFrom = fillPen(cur, 1)
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
